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
}

export interface Sink {
  save(sound: ResolvedSound, record: SoundRecord): Promise<void>;
}

export interface PipelineOpts {
  variants: number; // sounds to keep per sfx slot (2 gives the repeat penalty somewhere to go)
  concurrency: number;
  budgetMs: number; // soft target; after half of it Apify is skipped
  musicLengthS: number;
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

  // 1) search, 2) rank, 3) download the best that actually download
  const candidates = await searchSlot(slot, ctx);
  const ranked = rankCandidates(slot, candidates).filter((c) => !ctx.usedSourceIds.has(key(c)));
  const out: ResolvedSound[] = [];
  for (const c of ranked) {
    if (out.length >= want) break;
    ctx.usedSourceIds.add(key(c)); // claim before awaiting so parallel slots don't pick the same file
    try {
      const { bytes, contentType } = await ctx.providers.download(c.audioUrl);
      if (bytes.byteLength < 1000) throw new Error("file too small");
      out.push({ slot, variant: out.length, candidate: c, bytes, contentType });
    } catch (err) {
      ctx.log(`${slot.id}: download failed for ${c.source}:${c.sourceId} (${String(err)})`);
    }
  }
  if (out.length) return out;

  // 4) nothing usable → generate one
  const gen = await generateFor(slot, ctx);
  return gen ? [gen] : [];
}

async function searchSlot(slot: SfxSlot | MusicSlot, ctx: SlotCtx): Promise<Candidate[]> {
  const { freesound, apify } = ctx.providers;
  const all: Candidate[] = [];
  const enough = () => all.length >= 6; // keeps Freesound under its per-minute limit

  // Duration windows, tightest first. SFX must stay short; drones/music can be long loops.
  const windows =
    slot.kind === "music"
      ? [{ minDurationS: 20, maxDurationS: 240, loop: true }, { minDurationS: 20, maxDurationS: 300 }]
      : slot.id === "drone"
        ? [{ minDurationS: 5, maxDurationS: 60, loop: true }, { minDurationS: 5, maxDurationS: 60 }]
        : [{ minDurationS: 0.1, maxDurationS: slot.maxDurationS }, { minDurationS: 0.1, maxDurationS: slot.maxDurationS * 2 }];

  if (freesound) {
    outer: for (const w of windows) {
      for (const q of slot.queries) {
        try {
          all.push(...(await freesound(q, w)));
        } catch (err) {
          ctx.log(`${slot.id}: freesound "${q}" ${String(err)}`);
          if (String(err).includes("rate limit")) break outer;
        }
        if (enough()) break outer;
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
  try {
    let audio: GeneratedAudio | null = null;
    if (slot.kind === "music") {
      if (genMusic) audio = await genMusic(slot.genPrompt, ctx.opts.musicLengthS);
      else if (genSfx) audio = await genSfx(slot.genPrompt, { durationS: 20, loop: true }); // cheaper loop bed
    } else if (genSfx) {
      const loop = slot.id === "drone";
      audio = await genSfx(slot.genPrompt, { durationS: loop ? 15 : Math.max(0.5, slot.maxDurationS), loop });
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
    ctx.log(`${slot.id}: generation failed ${String(err)}`);
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
    if (slot.kind === "sfx" && slot.id !== "drone" && c.durationS > 0) {
      durationFit = c.durationS <= slot.maxDurationS ? 0.3 : -0.4 * (c.durationS / slot.maxDurationS - 1);
    }
    if (slot.kind === "music" && have.has("loop")) durationFit += 0.2;
    const cc0 = c.license === "CC0" ? 0.05 : 0; // tie-breaker: no credit needed
    return 2 * relevance + 0.5 * popularity + 0.3 * rating + durationFit + cc0;
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
    durationMs: Math.round(r.candidate.durationS * 1000), // 0 = unknown; player reads it from the decoded buffer
    loop: s.kind === "music" || s.id === "drone",
    source: r.candidate.source,
    sourceId: r.candidate.sourceId,
    license: r.candidate.license,
    attribution: r.candidate.attribution,
    pageUrl: r.candidate.pageUrl,
  };
}

const labelOf = (s: Slot) => (s.kind === "music" ? `music: ${s.mood}` : s.kind === "voice" ? `voice: "${s.line}"` : s.label);
const key = (c: Candidate) => `${c.source}:${c.sourceId}`;

async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}
