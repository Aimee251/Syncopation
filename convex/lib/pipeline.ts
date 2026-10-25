// The Scrape pipeline: plan → search (Freesound → Apify) → rank → download → store,
// with ElevenLabs/Cartesia generation as fallback. Providers and storage are
// injected, so this file runs unchanged in Convex and in a local script.

import type {
  Candidate,
  LibraryPlan,
  MusicSlot,
  ProgressEvent,
  ResolvedSound,
  SfxSlot,
  Slot,
  SoundRecord,
  VoiceSlot,
} from "./types";
import type { GeneratedAudio } from "./providers/elevenlabs";

export interface Providers {
  freesound?: (query: string, opts: { minDurationS: number; maxDurationS: number; loop?: boolean }) => Promise<Candidate[]>;
  apify?: (query: string, layer: "sfx" | "music") => Promise<Candidate[]>;
  genSfx?: (prompt: string, opts: { durationS?: number; loop?: boolean }) => Promise<GeneratedAudio>;
  genMusic?: (prompt: string, lengthS: number) => Promise<GeneratedAudio>;
  tts?: (line: string, emotion?: string) => Promise<GeneratedAudio>;
  download: (url: string) => Promise<{ bytes: ArrayBuffer; contentType: string }>;
  // CLAUDE CHOOSES: given the search results for a sound, return them best-first, or [] if none fits the talk
  choose?: (slot: SfxSlot | MusicSlot, cands: Candidate[]) => Promise<Candidate[]>;
  // nothing usable online (quota, throttled, offline): Claude may pick a fitting sound from earlier sessions, or none
  reuse?: (slot: SfxSlot | MusicSlot) => Promise<Candidate[]>;
}

export interface Sink {
  save(sound: ResolvedSound, record: SoundRecord): Promise<void>;
}

export interface PipelineOpts {
  variants: number; // sounds to keep per sfx slot (2 gives the repeat penalty somewhere to go)
  concurrency: number;
  budgetMs: number; // soft target; after half of it Apify is skipped
  musicLengthS: number;
  // ElevenLabs use: "fallback" = only when search finds nothing (default) | "sfx" = also add one generated
  // variant to every SFX slot | "all" = generate first (music beds too), search only if generation fails
  generate?: "fallback" | "sfx" | "all";
  // candidates to collect before searching stops (default 6). A first batch uses ~3: one search per sound, not six
  minCandidates?: number;
}

export const DEFAULT_OPTS: PipelineOpts = { variants: 2, concurrency: 6, budgetMs: 100_000, musicLengthS: 60 };

export interface PipelineResult {
  saved: SoundRecord[];
  missing: string[]; // slot ids that ended with nothing
  log: string[];
}

export async function runPipeline(
  plan: LibraryPlan,
  providers: Providers,
  sink: Sink,
  onProgress: (e: ProgressEvent) => Promise<void> | void,
  opts: PipelineOpts = DEFAULT_OPTS,
): Promise<PipelineResult> {
  const started = Date.now();
  const slots: Slot[] = [...plan.music, ...plan.sfx, ...plan.voice]; // music first: it's audible from second one
  const usedSourceIds = new Set<string>();
  const saved: SoundRecord[] = [];
  const missing: string[] = [];
  const log: string[] = [];
  let completed = 0;

  await onProgress({ stage: "searching", completed, total: slots.length, message: `Finding ${slots.length} sounds` });

  const ctx: SlotCtx = {
    providers,
    opts,
    usedSourceIds,
    log: (m) => log.push(m),
    pastHalf: () => Date.now() - started > opts.budgetMs / 2,
  };

  await mapLimit(slots, opts.concurrency, async (slot) => {
    let resolved: ResolvedSound[] = [];
    try {
      resolved = await resolveSlot(slot, ctx);
    } catch (err) {
      ctx.log(`${slot.id}: ${String(err)}`);
    }
    for (const r of resolved) {
      const record = toRecord(r);
      await sink.save(r, record);
      saved.push(record);
    }
    if (!resolved.length) missing.push(slot.id);
    completed++;
    await onProgress({
      stage: "searching",
      completed,
      total: slots.length,
      message: resolved.length ? `${labelOf(slot)} ✓ (${resolved[0].candidate.source})` : `${labelOf(slot)} — nothing found`,
    });
  });

  await onProgress({
    stage: "done",
    completed,
    total: slots.length,
    message: missing.length ? `Done; missing: ${missing.join(", ")}` : "Library ready",
  });
  return { saved, missing, log };
}

// ------------------------------------------------------------------ per slot

interface SlotCtx {
  providers: Providers;
  opts: PipelineOpts;
  usedSourceIds: Set<string>;
  log: (m: string) => void;
  pastHalf: () => boolean;
}

async function resolveSlot(slot: Slot, ctx: SlotCtx): Promise<ResolvedSound[]> {
  if (slot.kind === "voice") return resolveVoice(slot, ctx);
  const want = slot.kind === "sfx" ? ctx.opts.variants : 1;

  const mode = ctx.opts.generate ?? "fallback";
  if (mode === "all") {
    const g = await generateFor(slot, ctx);
    if (g) return [g];
  }

  // 1) search, 2) rank, 3) download the best that actually download
  let candidates = await searchSlot(slot, ctx);
  // nothing found online (daily quota used, throttled, offline): Claude decides whether an earlier session's sound fits
  if (!candidates.length && ctx.providers.reuse) {
    candidates = await ctx.providers.reuse(slot);
    if (candidates.length) sayOnce(ctx, `reuse-${slot.id}`, `${slot.id}: no search results → Claude picked "${candidates[0].name}" from an earlier session`);
  }
  let ranked = rankCandidates(slot, candidates).filter((c) => !ctx.usedSourceIds.has(key(c)));
  // the best few by tags go to Claude, who reads names/tags/lengths and picks the one that fits THIS talk (or none)
  if (ctx.providers.choose && ranked.length > 1 && candidates[0]?.source !== "local") {
    const picked = await ctx.providers.choose(slot, ranked.slice(0, 8));
    if (picked.length) ranked = [...picked, ...ranked.filter((c) => !picked.includes(c))];
  }
  const out: ResolvedSound[] = [];
  const tryGet = async (c: Candidate) => {
    ctx.usedSourceIds.add(key(c)); // claim before awaiting so parallel slots don't pick the same file
    try {
      const { bytes, contentType } = await ctx.providers.download(c.audioUrl);
      if (bytes.byteLength < 1000) throw new Error("file too small");
      return { slot, variant: 0, candidate: c, bytes, contentType } as ResolvedSound;
    } catch (err) {
      ctx.log(`${slot.id}: download failed for ${c.source}:${c.sourceId} (${String(err)})`);
      return null;
    }
  };
  let next = 0;
  while (out.length < want && next < ranked.length) {
    const batch = ranked.slice(next, next + (want - out.length)); // parallel for the ones still needed
    next += batch.length;
    for (const r of await Promise.all(batch.map(tryGet))) if (r) out.push({ ...r, variant: out.length });
  }
  if (out.length) {
    if (mode === "sfx" && slot.kind === "sfx") {
      const g = await generateFor(slot, ctx);
      if (g) out.push({ ...g, variant: out.length });
    }
    return out;
  }

  // 4) nothing usable → generate one
  const gen = await generateFor(slot, ctx);
  return gen ? [gen] : [];
}

/** Provider health, shared across a run: stops us burning requests on a provider that is rate-limited or out of credits. */
const health = { fsBlockedUntil: 0, fsBackoffMs: 60_000, genOutOfCredits: false, said: new Set<string>() };

export function providerStatus() {
  const now = Date.now();
  return {
    freesoundBlockedS: Math.max(0, Math.ceil((health.fsBlockedUntil - now) / 1000)),
    generationOutOfCredits: health.genOutOfCredits,
    stuck: now < health.fsBlockedUntil && health.genOutOfCredits,
  };
}

function sayOnce(ctx: SlotCtx, key: string, msg: string) {
  if (health.said.has(key)) return;
  health.said.add(key);
  ctx.log(msg);
}

async function searchSlot(slot: SfxSlot | MusicSlot, ctx: SlotCtx): Promise<Candidate[]> {
  const { freesound, apify } = ctx.providers;
  const all: Candidate[] = [];
  const enough = () => all.length >= (ctx.opts.minCandidates ?? 6); // keeps Freesound under its per-minute limit

  // Duration windows, tightest first. SFX must stay short; drones/music can be long loops.
  const windows =
    slot.kind === "music"
      ? [{ minDurationS: 20, maxDurationS: 240, loop: true }, { minDurationS: 20, maxDurationS: 300 }]
      : isBedSlot(slot)
        ? [{ minDurationS: 5, maxDurationS: 60, loop: true }, { minDurationS: 5, maxDurationS: 60 }]
        : [{ minDurationS: slot.lengthS ? Math.max(0.1, slot.lengthS * 0.3) : 0.1, maxDurationS: slot.maxDurationS }, { minDurationS: 0.1, maxDurationS: slot.maxDurationS * 2 }];

  if (freesound && Date.now() >= health.fsBlockedUntil) {
    // ONE search at a time, Claude's best phrase first; the next phrase / a wider duration only when results are thin.
    // (All phrases × both windows at once cost up to 6 searches per sound and tripped the 60/min limit.)
    outer: for (const w of windows) {
      let limited = false;
      for (const q0 of slot.queries) {
      const results = await Promise.all([q0].map(async (q) => {
        try {
          const r = await freesound(q, w);
          health.fsBackoffMs = 60_000; // a good answer: the limit is over
          return r;
        } catch (err) {
          if (String(err).includes("rate limit")) {
            limited = true;
            if (Date.now() >= health.fsBlockedUntil) { // first failure of this block: pause every search, with growing back-off
              health.fsBlockedUntil = Date.now() + health.fsBackoffMs;
              sayOnce(ctx, `fs${health.fsBlockedUntil}`, `Freesound rate limit hit: searches paused for ${Math.round(health.fsBackoffMs / 1000)} s (the API allows ~60 requests/min and ~2000/day)`);
              health.fsBackoffMs = Math.min(health.fsBackoffMs * 2, 600_000);
            }
          } else ctx.log(`${slot.id}: freesound "${q}" ${String(err)}`);
          return [] as Candidate[];
        }
      }));
      for (const r of results) all.push(...r);
      if (limited) break outer;
      if (all.length >= 1) break outer; // the first phrase that finds anything wins (a page holds up to 15 to choose from);
      // waiting for 3+ walked rare sounds through up to 6 searches one after another (slow, and quota)
      }
    }
  }
  if (apify && all.length < 2 && !ctx.pastHalf()) {
    try {
      all.push(...(await apify(slot.queries[0], slot.kind === "music" ? "music" : "sfx")));
    } catch (err) {
      ctx.log(`${slot.id}: apify ${String(err)}`);
    }
  }
  return all;
}

async function generateFor(slot: SfxSlot | MusicSlot, ctx: SlotCtx): Promise<ResolvedSound | null> {
  const { genSfx, genMusic } = ctx.providers;
  if (health.genOutOfCredits) return null; // the account has no credits: don't spend a request per sound finding that out
  try {
    let audio: GeneratedAudio | null = null;
    if (slot.kind === "music") {
      if (genMusic) audio = await genMusic(slot.genPrompt, ctx.opts.musicLengthS);
      else if (genSfx) audio = await genSfx(slot.genPrompt, { durationS: 20, loop: true }); // cheaper loop bed
    } else if (genSfx) {
      const loop = isBedSlot(slot);
      audio = await genSfx(slot.genPrompt, { durationS: loop ? 15 : Math.max(0.5, slot.lengthS ?? slot.maxDurationS), loop });
    }
    if (!audio) return null;
    return {
      slot,
      variant: 0,
      candidate: {
        source: "elevenlabs",
        sourceId: `gen:${slot.id}`,
        name: slot.genPrompt,
        tags: slot.tags,
        durationS: audio.durationS,
        audioUrl: "",
        license: "ElevenLabs generated (check your plan's commercial terms)",
      },
      bytes: audio.bytes,
      contentType: audio.contentType,
    };
  } catch (err) {
    if (/quota_exceeded|credits remaining|out of credits/i.test(String(err))) {
      health.genOutOfCredits = true;
      sayOnce(ctx, "gen-credits", "ElevenLabs is out of credits: generation is switched off for this run (sounds can only come from Freesound)");
    } else if (/missing_permissions|permission|unauthorized|HTTP 401|HTTP 402|invalid_api_key/i.test(String(err))) {
      // a key without the sound_generation permission fails EVERY request: stop asking after the first one
      health.genOutOfCredits = true;
      sayOnce(ctx, "gen-perm", "ElevenLabs refused (key lacks the sound_generation permission, or is invalid): generation is off for this run. " +
        "Fix: elevenlabs.io → API Keys → edit the key → enable Sound Effects / Sound Generation");
    } else ctx.log(`${slot.id}: generation failed ${String(err)}`);
    return null;
  }
}

async function resolveVoice(slot: VoiceSlot, ctx: SlotCtx): Promise<ResolvedSound[]> {
  const { tts, genSfx } = ctx.providers;
  try {
    const audio = tts
      ? await tts(slot.line, slot.emotion)
      : genSfx
        ? await genSfx(`A single eerie voice whispering "${slot.line}", close, dry`, { durationS: 2 })
        : null;
    if (!audio) return [];
    return [
      {
        slot,
        variant: 0,
        candidate: {
          source: tts ? "cartesia" : "elevenlabs",
          sourceId: `tts:${slot.id}`,
          name: slot.line,
          tags: slot.tags,
          durationS: audio.durationS,
          audioUrl: "",
          license: tts ? "Cartesia generated" : "ElevenLabs generated",
        },
        bytes: audio.bytes,
        contentType: audio.contentType,
      },
    ];
  } catch (err) {
    ctx.log(`${slot.id}: voice failed ${String(err)}`);
    return [];
  }
}

// ------------------------------------------------------------------ ranking

const ONE_OFF = /^(horn|honk|siren|bell|alarm|announc|whistle|scream|shout|bark|gunshot|shot|explosion|crash|bang|ring|ringing|voice|voices|speech|talk|talking|dialog|beep|klaxon|traffic|street|car|cars)/;
const MUSICAL = /^(music|musical|instrumental|ambient|pad|melody|melodic|soundtrack|score|cinematic|piano|strings|synth|orchestral|beat|loop|song|guitar|bass|chord|lofi|jazz|acoustic|ukulele|pizzicato|indie|pop)/;
const tokenize = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** Simple, explainable ranking: tag/name overlap with the slot, popularity, rating, duration fit. */
export function rankCandidates(slot: SfxSlot | MusicSlot, cands: Candidate[]): Candidate[] {
  const want = new Set([...slot.tags, ...slot.queries].flatMap(tokenize));
  const seen = new Set<string>();
  const unique = cands.filter((c) => (seen.has(key(c)) ? false : (seen.add(key(c)), true)));

  const score = (c: Candidate) => {
    const have = new Set([...c.tags, c.name].flatMap(tokenize));
    let overlap = 0;
    want.forEach((w) => have.has(w) && overlap++);
    const relevance = want.size ? overlap / want.size : 0;
    const popularity = Math.log10((c.downloads ?? 0) + 1) / 5; // ~0–1
    const rating = (c.rating ?? 0) / 5;
    let durationFit = 0;
    if (slot.kind === "sfx" && !isBedSlot(slot) && c.durationS > 0) {
      // the planner's own length is the target: closest (in ratio) wins; clips far too short or far too long lose
      durationFit = slot.lengthS
        ? 0.3 - 0.5 * Math.min(1, Math.abs(Math.log2(c.durationS / slot.lengthS)) / 2)
        : c.durationS <= slot.maxDurationS ? 0.3 : -0.4 * (c.durationS / slot.maxDurationS - 1);
    }
    if (slot.kind === "music" && have.has("loop")) durationFit += 0.2;
    // LOOPED music/backgrounds must be steady and musical: a horn, alarm or voice in the file comes back every loop,
    // and a street recording is not music. Penalise one-off noises; reward files that are clearly music.
    let bedFit = 0;
    if (slot.kind === "music" || isBedSlot(slot)) {
      if ([...have].some((w) => ONE_OFF.test(w))) bedFit -= 1.5;
      if (slot.kind === "music") bedFit += [...have].some((w) => MUSICAL.test(w)) ? 0.4 : -0.8;
    }
    const cc0 = c.license === "CC0" ? 0.05 : 0; // tie-breaker: no credit needed
    return 2 * relevance + 0.5 * popularity + 0.3 * rating + durationFit + cc0 + bedFit;
  };
  return unique.map((c) => [score(c), c] as const).sort((a, b) => b[0] - a[0]).map(([, c]) => c);
}

// ------------------------------------------------------------------ helpers

function toRecord(r: ResolvedSound): SoundRecord {
  const s = r.slot;
  const layer = s.kind;
  return {
    id: `${s.id}#${r.variant}`,
    slotId: s.id,
    variant: r.variant,
    layer,
    label: labelOf(s),
    tags: Array.from(new Set([...s.tags, ...r.candidate.tags.slice(0, 8)])),
    intensity: s.kind === "voice" ? 0.9 : s.intensity,
    mood: s.kind === "music" ? s.mood : undefined,
    // Voice effects are always committed (spec: highest margin, peak moments only)
    safety: s.kind === "sfx" ? s.safety : s.kind === "music" ? "speculative" : "committed",
    ...(s.kind === "sfx" ? { instant: s.instant, emphasis: s.emphasis, softness: s.softness, attack: s.attack, tail: s.tail, lengthS: s.lengthS, description: s.event } : {}),
    durationMs: Math.round(r.candidate.durationS * 1000), // 0 = unknown; player reads it from the decoded buffer
    loop: s.kind === "music" || (s.kind === "sfx" && isBedSlot(s)),
    source: r.candidate.source,
    sourceId: r.candidate.sourceId,
    license: r.candidate.license,
    attribution: r.candidate.attribution,
    pageUrl: r.candidate.pageUrl,
  };
}

const labelOf = (s: Slot) => (s.kind === "music" ? `music: ${s.mood}` : s.kind === "voice" ? `voice: "${s.line}"` : s.label);
const key = (c: Candidate) => `${c.source}:${c.sourceId}`;
/** Long, loopable background beds (drone, ambience, room tone) as opposed to short one-shot effects. */
const isBedSlot = (s: SfxSlot | MusicSlot) => s.kind === "sfx" && (s.id === "drone" || /ambien|atmos|drone|room_?tone/i.test(`${s.id} ${s.label}`));

async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}
