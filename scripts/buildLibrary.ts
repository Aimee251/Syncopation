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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fallbackPlan, planWithClaude } from "../convex/lib/planner";
import { DEFAULT_OPTS, providerStatus, runPipeline, type PipelineOpts } from "../convex/lib/pipeline";
import { providersFromEnv } from "../convex/lib/providersFromEnv";
import type { LibraryPlan, ProgressEvent, SetupInput, SoundRecord } from "../convex/lib/types";

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

  const { providers, enabled } = providersFromEnv(env);
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
export async function finishLibrary(outDir: string, opts: PipelineOpts = { ...DEFAULT_OPTS, variants: 2, concurrency: 3, budgetMs: 120_000 }) {
  const pendingPath = join(outDir, "pending.json");
  if (!existsSync(pendingPath)) return [];
  const { plan, generate } = JSON.parse(await readFile(pendingPath, "utf8")) as { plan: LibraryPlan; generate?: PipelineOpts["generate"] };
  const { providers } = providersFromEnv(cleanEnv());
  await mkdir(join(outDir, "sounds"), { recursive: true });
  const fresh: Array<SoundRecord & { url: string }> = [];
  await runPipeline(plan, providers, {
    save: async (sound, record) => {
      const ext = sound.contentType.includes("ogg") ? "ogg" : sound.contentType.includes("wav") ? "wav" : "mp3";
      const file = `sounds/${record.id.replace("#", "_")}.${ext}`;
      await writeFile(join(outDir, file), Buffer.from(sound.bytes));
      fresh.push({ ...record, url: `/${file}` });
    },
  }, () => { }, { ...opts, generate: generate ?? opts.generate });
  try {
    const path = join(outDir, "library.json");
    const lib = JSON.parse(await readFile(path, "utf8"));
    lib.sounds.push(...fresh);
    lib.moods = [...new Set([...(lib.moods ?? []), ...plan.music.map((m) => m.mood)])];
    lib.sfxIds = [...new Set([...(lib.sfxIds ?? []), ...fresh.filter((r) => r.layer === "sfx").map((r) => r.slotId)])];
    lib.voiceIds = [...new Set([...(lib.voiceIds ?? []), ...fresh.filter((r) => r.layer === "voice").map((r) => r.slotId)])];
    await writeFile(path, JSON.stringify(lib, null, 2));
  } catch { /* the new sounds still work for this run */ }
  await rm(pendingPath, { force: true });
  return fresh;
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
  const { providers } = providersFromEnv(env);
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
  // append to library.json so the next run of the same session has them too
  try {
    const path = join(outDir, "library.json");
    const lib = JSON.parse(await readFile(path, "utf8"));
    lib.sounds.push(...fresh);
    lib.sfxIds = [...new Set([...(lib.sfxIds ?? []), ...fresh.map((r) => r.slotId)])];
    await writeFile(path, JSON.stringify(lib, null, 2));
  } catch { /* library.json missing: the new sounds still work for this run */ }
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