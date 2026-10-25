// Offline version of the Scrape service: same planner + pipeline, but writes
// <out>/library.json and <out>/sounds/*.mp3 instead of Convex storage.
// Covers build-order step 2 ("add mp3s matching library.json") before Convex is wired.
//
//   FREESOUND_API_KEY=... npx tsx scripts/buildLibrary.ts \
//     --theme spooky_story --keywords "abandoned house, storm, footsteps, ghost" \
//     --prompt "A ghost story in an old farmhouse" [--voice] [--no-music] [--no-sfx] [--out public]
//
// Reads the same env vars as convex/scrape.ts (put them in .env.local and use `node --env-file`).
// Also importable: cli.ts calls buildSoundLibrary() with the answers from its setup questions.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fallbackPlan, planWithClaude } from "../convex/lib/planner";
import { DEFAULT_OPTS, providerStatus, runPipeline, type PipelineOpts } from "../convex/lib/pipeline";
import { providersFromEnv } from "../convex/lib/providersFromEnv";
import type { Candidate, LibraryPlan, MusicSlot, ProgressEvent, SetupInput, SfxSlot, SoundRecord } from "../convex/lib/types";
import type { Providers } from "../convex/lib/pipeline";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, def = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

// .env lines like `KEY= value` leave a leading space that breaks auth headers
const cleanEnv = () => {
  const e = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v!.trim()])) as Record<string, string>;
  if (e.APIFY_ENABLE !== "1") delete e.APIFY_TOKEN; // the actor returns HTTP 403 for this token: don't spend a request per sound on it
  return e;
};

// ------------------------------------------------------------------------------------------- QUOTA + CLAUDE CHOOSES
// Freesound: ~60 searches/min and ~2000/day per key. ElevenLabs: monthly credits. A session used to spend 200+ searches
// and an ElevenLabs generation per effect. Now:
//   · searches are paced (freesound.ts) and remembered for a day (.cache/freesound): the SAME phrase Claude wrote isn't
//     searched twice — the phrases still come from Claude for every theme, nothing is hardcoded
//   · a daily counter (.cache/usage.json) shows how much of the 2000 is used (npm run keys)
//   · ElevenLabs credits are checked once; with none left, generation is skipped instead of failing per sound
//   · CLAUDE picks the file from the search results (names, tags, length) for the background batches, and when nothing
//     is found online CLAUDE decides whether a sound from an earlier session genuinely fits — or leaves the slot empty
const CACHE = ".cache";
const themeOf = (dir: string) => { try { return JSON.parse(readFileSync(join(dir, "library.json"), "utf8")).theme ?? ""; } catch { return ""; } };
const sha = (x: string) => createHash("sha1").update(x).digest("hex").slice(0, 20);
const today = () => new Date().toISOString().slice(0, 10);
export function usageToday(): { date: string; freesound: number } {
  try { const u = JSON.parse(readFileSync(join(CACHE, "usage.json"), "utf8")); if (u.date === today()) return u; } catch { }
  return { date: today(), freesound: 0 };
}
function countSearch() {
  const u = usageToday(); u.freesound++;
  try { mkdirSync(CACHE, { recursive: true }); writeFileSync(join(CACHE, "usage.json"), JSON.stringify(u)); } catch { }
  if (u.freesound === 1600) console.warn("Freesound: 1600 of ~2000 searches used today — a 2nd FREESOUND_API_KEY would help");
}

// one Claude call for several sounds at once: requests arriving within 400 ms are answered together
function batcher<T, R>(run: (items: T[]) => Promise<R[]>, waitMs = 400, max = 10) {
  let queue: { item: T; resolve: (r: R) => void }[] = [], timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    const items = queue; queue = []; timer = null;
    let out: R[] = [];
    try { out = await run(items.map((q) => q.item)); } catch { }
    items.forEach((q, i) => q.resolve(out[i] as R));
  };
  return (item: T) => new Promise<R>((resolve) => {
    queue.push({ item, resolve });
    if (queue.length >= max) { if (timer) clearTimeout(timer); flush(); } else if (!timer) timer = setTimeout(flush, waitMs);
  });
}
async function askClaude(env: Record<string, string>, system: string, user: string, schema: any): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || "claude-haiku-5-5", max_tokens: 1500, system,
      tools: [{ name: "pick", description: "Your picks", input_schema: schema }], tool_choice: { type: "tool", name: "pick" },
      messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}`);
  const data: any = await res.json();
  return data.content?.find((c: any) => c.type === "tool_use")?.input;
}
const PICK_SCHEMA = { type: "object", required: ["picks"], properties: { picks: { type: "array", items: { type: "object", required: ["id", "choice"],
  properties: { id: { type: "string" }, choice: { type: "array", items: { type: "integer" }, maxItems: 2, description: "indexes of the fitting files, best first; [] if none fits" } } } } } };
const describe = (slot: SfxSlot | MusicSlot) => slot.kind === "music"
  ? `music for the mood "${slot.mood}" (${slot.tags.slice(0, 5).join(", ")})`
  : `sound effect "${slot.label}" (${slot.tags.slice(0, 5).join(", ")}; ${slot.maxDurationS >= 10 ? "a steady background loop" : `a one-off sound, up to ${slot.maxDurationS} s`})`;

// sounds already on this machine, for Claude's reuse decision
type LocalRec = Candidate & { layer: string; loop: boolean };
let localIndex: LocalRec[] | null = null;
function buildLocalIndex(): LocalRec[] {
  const out: LocalRec[] = [], seen = new Set<string>();
  const dirs = [...(existsSync("sessions") ? readdirSync("sessions").map((d) => join("sessions", d)) : []), "public"];
  for (const dir of dirs) {
    let lib: any;
    try { lib = JSON.parse(readFileSync(join(dir, "library.json"), "utf8")); } catch { continue; }
    for (const r of lib.sounds ?? []) {
      const file = resolve(dir, String(r.url ?? "").replace(/^\//, ""));
      if (!r.url || seen.has(String(r.slotId) + r.layer) || !existsSync(file)) continue; // one file per kind of sound
      seen.add(String(r.slotId) + r.layer);
      out.push({ source: "local", sourceId: file, name: String(r.label ?? r.slotId), tags: (r.tags ?? []).slice(0, 6), durationS: (r.durationMs ?? 0) / 1000,
        audioUrl: "file://" + file, license: r.license ?? "unknown", attribution: r.attribution, pageUrl: r.pageUrl, layer: r.layer, loop: !!r.loop });
    }
  }
  return out;
}

export function withQuotaAndClaude<T extends { providers: Providers; enabled: string[] }>(r: T, outDir: string, theme: string, claudeChooses: boolean | "beds"): T {
  const env = cleanEnv();
  const p = { ...r.providers };
  const own = resolve(outDir);
  // remembered searches + daily counter
  if (p.freesound) {
    const search = p.freesound;
    p.freesound = async (q, o) => {
      const file = join(CACHE, "freesound", sha(q + JSON.stringify(o)) + ".json");
      try { const c = JSON.parse(readFileSync(file, "utf8")); if (Date.now() - c.at < 86_400_000) return c.results; } catch { }
      countSearch();
      const results = await search(q, o);
      try { mkdirSync(join(CACHE, "freesound"), { recursive: true }); writeFileSync(file, JSON.stringify({ at: Date.now(), results })); } catch { }
      return results;
    };
  }
  // ElevenLabs: check credits ONCE; with none left, don't ask per sound
  if ((p.genSfx || p.genMusic) && env.ELEVENLABS_API_KEY) {
    const credits = fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(5000) })
      .then(async (res) => { if (!res.ok) return Infinity; const s: any = await res.json(); return Number(s.character_limit ?? 0) - Number(s.character_count ?? 0); })
      .catch(() => Infinity);
    let warned = false;
    const gate = <F extends (...a: any[]) => Promise<any>>(fn?: F) => fn && (async (...a: any[]) => {
      if ((await credits) <= 0) { if (!warned) { warned = true; console.warn("ElevenLabs: no credits left — sounds are searched only (no generation) until it resets"); } throw new Error("ElevenLabs out of credits"); }
      return fn(...a);
    }) as F;
    p.genSfx = gate(p.genSfx); p.genMusic = gate(p.genMusic);
  }
  if (env.ANTHROPIC_API_KEY) {
    if (claudeChooses) {
      const choose = batcher<{ slot: SfxSlot | MusicSlot; cands: Candidate[] }, Candidate[]>(async (items) => {
        const user = `Live talk: "${theme}". For each sound, pick the file(s) that ARE the intended sound (not something else with similar words, ` +
          `no voices/music in an effect, no one-off events in a background loop). [] if none fits.\n\n` +
          items.map((it) => `id ${it.slot.id}: ${describe(it.slot)}\n` + it.cands.map((c, i) => `  ${i}. "${c.name}" [${c.tags.slice(0, 6).join(", ")}] ${c.durationS.toFixed(1)} s${c.rating ? `, rated ${c.rating.toFixed(1)}` : ""}`).join("\n")).join("\n\n");
        const out = await askClaude(env, "You choose sound files for a live sound designer. Be strict: the file must sound like the described sound.", user, PICK_SCHEMA);
        return items.map((it) => {
          const pick = (out?.picks ?? []).find((x: any) => x.id === it.slot.id);
          return pick ? (pick.choice as number[]).map((i) => it.cands[i]).filter(Boolean) : it.cands; // no answer: keep the tag ranking
        });
      });
      const isBedSlot = (slot: SfxSlot | MusicSlot) => slot.kind === "music" || slot.maxDurationS >= 10 || /ambien|atmos|drone|room_?tone|bed/i.test(slot.id);
      p.choose = (slot, cands) => (claudeChooses === "beds" && !isBedSlot(slot) ? Promise.resolve(cands) : choose({ slot, cands }));
    }
    const reuse = batcher<SfxSlot | MusicSlot, Candidate[]>(async (slots) => {
      localIndex ??= buildLocalIndex();
      const bed = (s: SfxSlot | MusicSlot) => s.kind === "sfx" && (s.maxDurationS >= 10 || /ambien|atmos|drone|room_?tone|bed/i.test(s.id)); // "rain_ambience_cafe" is a loop
      const kinds = (s: SfxSlot | MusicSlot) => (c: LocalRec) => !c.sourceId.startsWith(own) && (s.kind === "music" ? c.layer === "music" : bed(s) ? c.loop && c.layer !== "music" : c.layer === "sfx" && !c.loop);
      // up to 60 files of EACH kind that is needed (music / background loops / one-off effects), so no kind is cut off
      const pool: LocalRec[] = [];
      for (const s of slots) for (const c of localIndex.filter(kinds(s))) if (!pool.includes(c) && pool.filter(kinds(s)).length < 60) pool.push(c);
      if (!pool.length) return slots.map(() => []);
      const user = `Live talk: "${theme}". The online sound search found nothing for the sounds below. These files from earlier talks are on this machine:\n` +
        pool.map((c, i) => `  ${i}. ${c.layer}${c.loop ? " loop" : ""}: "${c.name}" [${c.tags.join(", ")}]`).join("\n") +
        `\n\nFor each needed sound, pick a file ONLY if it genuinely works as that sound in this talk (right kind: music for music, a loop for a background, a one-off for an effect). [] otherwise.\n` +
        slots.map((s) => `id ${s.id}: ${describe(s)}`).join("\n");
      const out = await askClaude(env, "You reuse sound files for a live sound designer. Never force a bad fit: silence is better than a wrong sound.", user, PICK_SCHEMA);
      return slots.map((s) => {
        const pick = (out?.picks ?? []).find((x: any) => x.id === s.id);
        return (pick?.choice ?? []).map((i: number) => pool[i]).filter((c: LocalRec | undefined) => c && kinds(s)(c));
      });
    });
    p.reuse = (slot) => reuse(slot);
  }
  const download = p.download;
  p.download = (url: string) => url.startsWith("file://")
    ? readFile(url.slice(7)).then((b) => ({ bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, contentType: url.endsWith(".wav") ? "audio/wav" : url.endsWith(".ogg") ? "audio/ogg" : "audio/mpeg" }))
    : download(url);
  return { ...r, providers: p };
}

/** Plan with Claude, retrying transient network errors (e.g. "fetch failed") before giving up. */
async function planRetry(input: SetupInput, key: string, model: string): Promise<LibraryPlan> {
  let last: unknown;
  for (let i = 1; i <= 4; i++) {
    try {
      return await planWithClaude(input, key, model);
    } catch (e) {
      last = e;
      console.warn(`planner attempt ${i}/4 failed: ${String(e).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  console.warn("\n!!! PLANNER FAILED — using the tiny generic fallback library. Check your network and re-run. !!!\n");
  throw last;
}

export interface StartedPlans { firstBatch: number; full: Promise<LibraryPlan>; fast: Promise<LibraryPlan> | null }

/** Starts the Claude planning calls without waiting for them, so cli.ts can run them while the user is still
 *  answering the remaining setup questions. Pass the result to buildSoundLibrary as `pre`. */
export function startPlans(input: SetupInput, firstBatch = 0): StartedPlans {
  const env = cleanEnv();
  const key = env.ANTHROPIC_API_KEY;
  const model = env.CLAUDE_MODEL || "claude-haiku-5-5";
  const full: Promise<LibraryPlan> = key
    ? planRetry(input, key, model).catch((e) => {
      console.warn("planner fell back:", String(e));
      return fallbackPlan(input);
    })
    : Promise.resolve(fallbackPlan(input));
  const fast = key && firstBatch > 0 ? planWithClaude(input, key, model, firstBatch) : null;
  fast?.catch(() => { }); // handled where it is awaited
  return { firstBatch, full, fast };
}

export async function buildSoundLibrary(
  input: SetupInput,
  outDir = "public",
  onProgress: (e: ProgressEvent) => void = (e) => console.log(`[${e.completed}/${e.total}] ${e.message}`),
  opts: PipelineOpts = DEFAULT_OPTS,
  // BATCHES: with firstBatch = N, only the opening music moods + the N sound effects the planner listed first are
  // fetched now (quick search, 1 variant); the rest of the plan goes to pending.json and is fetched in the
  // background while the talk runs (predict.ts → finishLibrary). The talk starts in ~15-25 s instead of minutes.
  firstBatch = 0,
  pre?: StartedPlans,
) {
  const env = cleanEnv();
  const plans = pre && pre.firstBatch === firstBatch ? pre : startPlans(input, firstBatch);
  let plan: LibraryPlan;
  let later: LibraryPlan | null = null;
  let laterPromise: Promise<LibraryPlan | null> | null = null;
  if (firstBatch > 0 && plans.fast) {
    // FAST START: the full plan (~15-20 s of Claude output) runs in the background; batch 1 only needs a tiny plan.
    const full = plans.full;
    try {
      plan = await plans.fast;
    } catch (e) {
      console.warn("fast plan failed, waiting for the full plan:", String(e).slice(0, 100));
      const f = await full;
      plan = { sfx: f.sfx.slice(0, firstBatch), music: f.music.slice(0, 2), voice: [] };
      later = { sfx: f.sfx.slice(firstBatch), music: f.music.slice(2), voice: f.voice };
    }
    if (!later) {
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, "pending.waiting"), "1");
      const haveSfx = new Set(plan.sfx.map((s) => s.id));
      const haveMood = new Set(plan.music.map((m) => m.mood));
      laterPromise = full.then((f) => ({
        sfx: f.sfx.filter((s) => !haveSfx.has(s.id)),
        music: f.music.filter((m) => !haveMood.has(m.mood)),
        voice: f.voice,
      })).catch(() => null);
    }
    console.log(`Plan: fast ${plan.sfx.length} sfx, ${plan.music.length} music (full plan continues in background)`);
  } else {
    plan = await plans.full;
    console.log(`Plan: ${plan.sfx.length} sfx, ${plan.music.length} music, ${plan.voice.length} voice`);
    if (firstBatch > 0) {
      later = { sfx: plan.sfx.slice(firstBatch), music: plan.music.slice(2), voice: plan.voice };
      plan = { sfx: plan.sfx.slice(0, firstBatch), music: plan.music.slice(0, 2), voice: [] };
    }
  }
  if (firstBatch > 0) {
    opts = { ...opts, generate: "fallback", concurrency: Math.max(opts.concurrency, 8) }; // same quality settings; speed comes from parallelism
    console.log(`Batch 1 now: ${plan.music.length} music + ${plan.sfx.length} sfx · batch 2 while you talk`);
  }

  const { providers, enabled } = withQuotaAndClaude(providersFromEnv(env), outDir, input.prompt || input.theme, firstBatch === 0 ? true : "beds"); // batch 1: Claude picks the music + background (heard all the time); effects keep the fast ranking
  console.log(`Providers: ${enabled.join(", ") || "none"}`);
  if (!providers.freesound && !providers.apify && !providers.genSfx) throw new Error("Set FREESOUND_API_KEY (or APIFY_TOKEN / ELEVENLABS_API_KEY)");

  await mkdir(join(outDir, "sounds"), { recursive: true });
  const records: Array<SoundRecord & { file: string }> = [];

  const t0 = Date.now();
  const result = await runPipeline(
    plan,
    providers,
    {
      save: async (sound, record) => {
        const ext = sound.contentType.includes("ogg") ? "ogg" : sound.contentType.includes("wav") ? "wav" : "mp3";
        const file = `sounds/${record.id.replace("#", "_")}.${ext}`;
        await writeFile(join(outDir, file), Buffer.from(sound.bytes));
        records.push({ ...record, file });
      },
    },
    onProgress,
    opts,
  );

  const has = new Set(records.map((r) => r.slotId));
  const library = {
    theme: input.theme,
    moods: plan.music.map((m) => m.mood),
    density: input.density,
    layers: input.layers,
    sfxIds: plan.sfx.map((s) => s.id).filter((id) => has.has(id)),
    voiceIds: plan.voice.map((s) => s.id).filter((id) => has.has(id)),
    sounds: records.sort((a, b) => a.id.localeCompare(b.id)).map(({ file, ...r }) => ({ ...r, url: `/${file}` })),
    credits: records.filter((r) => r.attribution).map((r) => r.attribution),
  };
  const libraryPath = join(outDir, "library.json");
  await writeFile(libraryPath, JSON.stringify(library, null, 2));
  const writePending = async (l: LibraryPlan | null) => {
    if (l && (l.sfx.length || l.music.length || l.voice.length))
      await writeFile(join(outDir, "pending.json"), JSON.stringify({ plan: l, generate: firstBatchGenerate }, null, 2));
    await rm(join(outDir, "pending.waiting"), { force: true });
  };
  if (laterPromise) laterPromise.then(writePending).catch(() => rm(join(outDir, "pending.waiting"), { force: true }));
  else await writePending(later);
  console.log(`\nWrote ${records.length} sounds in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${libraryPath}`);
  if (result.missing.length) console.log(`Missing: ${result.missing.join(", ")}`);
  if (result.log.length) console.log(`Notes:\n  ${result.log.join("\n  ")}`);
  if (!records.length) {
    const st = providerStatus();
    console.log(
      `\n!! NO SOUNDS WERE FOUND. This is a provider problem, not the plan: ` +
      (st.freesoundBlockedS ? `Freesound is rate-limited (retry in ~${st.freesoundBlockedS} s; limits are ~60 requests/min and ~2000/day). ` : "") +
      (st.generationOutOfCredits ? `ElevenLabs has no credits left (top up or use a new ELEVENLABS_API_KEY). ` : "") +
      (!st.freesoundBlockedS && !st.generationOutOfCredits ? `See the Notes above. ` : ""),
    );
  }
  return { library, libraryPath, missing: result.missing };
}

const firstBatchGenerate = "fallback"; // batch 2: search only, ElevenLabs just for gaps (faster, saves credits)

/**
 * BATCH 2: fetches what buildSoundLibrary(firstBatch) left in pending.json, appends it to library.json and
 * removes pending.json. Called by predict.ts in the background once the talk has started.
 */
export async function finishLibrary(outDir: string, opts: PipelineOpts = { ...DEFAULT_OPTS, variants: 2, concurrency: 3, budgetMs: 120_000 },
  onSound?: (rec: SoundRecord & { url: string }) => void | Promise<void>, // each sound the moment it's saved (it can play right away)
) {
  const pendingPath = join(outDir, "pending.json");
  if (!existsSync(pendingPath)) return [];
  const { plan, generate } = JSON.parse(await readFile(pendingPath, "utf8")) as { plan: LibraryPlan; generate?: PipelineOpts["generate"] };
  const { providers } = withQuotaAndClaude(providersFromEnv(cleanEnv()), outDir, themeOf(outDir), true);
  await mkdir(join(outDir, "sounds"), { recursive: true });
  const fresh: Array<SoundRecord & { url: string }> = [];
  await runPipeline(plan, providers, {
    save: async (sound, record) => {
      const ext = sound.contentType.includes("ogg") ? "ogg" : sound.contentType.includes("wav") ? "wav" : "mp3";
      const file = `sounds/${record.id.replace("#", "_")}.${ext}`;
      await writeFile(join(outDir, file), Buffer.from(sound.bytes));
      const rec = { ...record, url: `/${file}` };
      fresh.push(rec);
      await onSound?.(rec);
    },
  }, () => { }, { ...opts, generate: generate ?? opts.generate });
  await appendToLibrary(outDir, fresh, plan.music.map((m) => m.mood));
  await rm(pendingPath, { force: true });
  return fresh;
}

// library.json is written by batch 2 AND the live rounds, which now run at the same time: one write at a time
let libWrite: Promise<unknown> = Promise.resolve();
function appendToLibrary(outDir: string, fresh: Array<SoundRecord & { url: string }>, moods: string[] = []) {
  const job = libWrite.then(async () => {
    const path = join(outDir, "library.json");
    const lib = JSON.parse(await readFile(path, "utf8"));
    const ids = new Set(lib.sounds.map((r: SoundRecord) => r.id));
    lib.sounds.push(...fresh.filter((r) => !ids.has(r.id)));
    lib.moods = [...new Set([...(lib.moods ?? []), ...moods])];
    lib.sfxIds = [...new Set([...(lib.sfxIds ?? []), ...fresh.filter((r) => r.layer === "sfx").map((r) => r.slotId)])];
    lib.voiceIds = [...new Set([...(lib.voiceIds ?? []), ...fresh.filter((r) => r.layer === "voice").map((r) => r.slotId)])];
    await writeFile(path, JSON.stringify(lib, null, 2));
  }).catch(() => { /* library.json missing: the new sounds still work for this run */ });
  libWrite = job;
  return job;
}

/**
 * Second (third, …) scraping round while the talk is running: plans ONLY sound effects that are not in the
 * library yet, for the moment described by `prompt`, saves them into the same session folder and appends them
 * to library.json. Returns the new records, each with a `url` relative to outDir.
 */
export async function expandLibrary(
  prompt: string,
  existingIds: Set<string>,
  outDir: string,
  opts: PipelineOpts = { ...DEFAULT_OPTS, variants: 1, budgetMs: 45_000 }, // live rounds: one clip per sound, so they land sooner
  keywords: string[] = [], // sound effects the speaker named: each gets its own slot
  onPlan?: (plan: LibraryPlan) => void, // lets the caller log the director's read of the speech
) {
  const env = cleanEnv();
  const input: SetupInput = {
    prompt, keywords, theme: "live follow-up (the speaker's own words)", moods: [], themeSfx: [], density: "expressive",
    layers: { music: false, sfx: true, voice: false },
    live: !keywords.length, // a round for typed keywords is a plain plan; a round for speech is the director's decision
  };
  const none: LibraryPlan = { sfx: [], music: [], voice: [] };
  const plan = env.ANTHROPIC_API_KEY
    ? await planRetry(input, env.ANTHROPIC_API_KEY, env.CLAUDE_MODEL || "claude-haiku-5-5").catch(() => (input.live ? none : fallbackPlan(input)))
    : input.live ? none : fallbackPlan(input);
  onPlan?.(plan);
  plan.sfx = plan.sfx.filter((s) => !existingIds.has(s.id));
  plan.music = []; plan.voice = [];
  if (!plan.sfx.length) return [];
  const { providers } = withQuotaAndClaude(providersFromEnv(env), outDir, prompt, true);
  await mkdir(join(outDir, "sounds"), { recursive: true });
  const fresh: Array<SoundRecord & { url: string }> = [];
  await runPipeline(plan, providers, {
    save: async (sound, record) => {
      const ext = sound.contentType.includes("ogg") ? "ogg" : sound.contentType.includes("wav") ? "wav" : "mp3";
      const file = `sounds/${record.id.replace("#", "_")}.${ext}`;
      await writeFile(join(outDir, file), Buffer.from(sound.bytes));
      fresh.push({ ...record, url: `/${file}` });
    },
  }, () => { }, opts);
  await appendToLibrary(outDir, fresh); // so the next run of the same session has them too
  return fresh;
}

async function main() {
  // any theme text; with no --moods the AI picks the music moods, and with no --keywords it infers the sounds from the prompt
  const theme = opt("theme", opt("prompt", "custom"));
  const keywords = opt("keywords").split(",").map((s) => s.trim()).filter(Boolean);
  const moods = opt("moods").split(",").map((s) => s.trim()).filter(Boolean);
  if (!keywords.length && !opt("prompt")) throw new Error('Pass --prompt "describe the talk" and/or --keywords "a, b, c"');

  await buildSoundLibrary(
    {
      prompt: opt("prompt", theme),
      keywords,
      theme,
      moods,
      themeSfx: [],
      layers: { music: !flag("no-music"), sfx: !flag("no-sfx"), voice: flag("voice") },
      density: opt("density", "normal") as SetupInput["density"],
    },
    opt("out", "public"),
  );
}

// run as a script, not when imported by cli.ts
if (process.argv[1]?.endsWith("buildLibrary.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}