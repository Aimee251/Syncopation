// Offline version of the Scrape service: same planner + pipeline, but writes
// public/library.json and public/sounds/*.mp3 instead of Convex storage.
// Covers build-order step 2 ("add mp3s matching library.json") before Convex is wired.
//
//   FREESOUND_API_KEY=... npx tsx scripts/buildLibrary.ts \
//     --theme spooky_story --keywords "abandoned house, storm, footsteps, ghost" \
//     --prompt "A ghost story in an old farmhouse" [--voice] [--no-music] [--no-sfx]
//
// Reads the same env vars as convex/scrape.ts (put them in .env.local and use `node --env-file`).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fallbackPlan, planWithClaude } from "../convex/lib/planner";
import { DEFAULT_OPTS, runPipeline } from "../convex/lib/pipeline";
import { providersFromEnv } from "../convex/lib/providersFromEnv";
import type { SetupInput, SoundRecord } from "../convex/lib/types";
import { THEMES } from "../src/themes";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, def = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

async function main() {
  const theme = THEMES.find((t) => t.id === opt("theme", "spooky_story")) ?? THEMES[0];
  const keywords = opt("keywords").split(",").map((s) => s.trim()).filter(Boolean);
  if (!keywords.length) throw new Error('Pass --keywords "a, b, c"');

  const input: SetupInput = {
    prompt: opt("prompt"),
    keywords,
    theme: theme.id,
    moods: theme.moods,
    themeSfx: flag("no-sfx") ? [] : theme.sfx,
    layers: { music: !flag("no-music"), sfx: !flag("no-sfx"), voice: flag("voice") },
    density: (opt("density", "normal") as SetupInput["density"]),
  };

  const env = process.env;
  const plan = env.ANTHROPIC_API_KEY
    ? await planWithClaude(input, env.ANTHROPIC_API_KEY, env.CLAUDE_MODEL || "claude-haiku-5-5").catch((e) => {
        console.warn("planner fell back:", String(e));
        return fallbackPlan(input);
      })
    : fallbackPlan(input);
  console.log(`Plan: ${plan.sfx.length} sfx, ${plan.music.length} music, ${plan.voice.length} voice`);

  const { providers, enabled } = providersFromEnv(env);
  console.log(`Providers: ${enabled.join(", ") || "none"}`);
  if (!providers.freesound && !providers.apify && !providers.genSfx) throw new Error("Set FREESOUND_API_KEY (or APIFY_TOKEN / ELEVENLABS_API_KEY)");

  const outDir = opt("out", "public");
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
    (e) => console.log(`[${e.completed}/${e.total}] ${e.message}`),
    DEFAULT_OPTS,
  );

  const has = new Set(records.map((r) => r.slotId));
  const library = {
    theme: theme.id,
    moods: theme.moods,
    density: input.density,
    layers: input.layers,
    sfxIds: plan.sfx.map((s) => s.id).filter((id) => has.has(id)),
    voiceIds: plan.voice.map((s) => s.id).filter((id) => has.has(id)),
    sounds: records.sort((a, b) => a.id.localeCompare(b.id)).map(({ file, ...r }) => ({ ...r, url: `/${file}` })),
    credits: records.filter((r) => r.attribution).map((r) => r.attribution),
  };
  await writeFile(join(outDir, "library.json"), JSON.stringify(library, null, 2));
  console.log(`\nWrote ${records.length} sounds in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${outDir}/library.json`);
  if (result.missing.length) console.log(`Missing: ${result.missing.join(", ")}`);
  if (result.log.length) console.log(`Notes:\n  ${result.log.join("\n  ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
