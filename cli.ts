// cli.ts — terminal front end for the whole backend, until the real UI exists.
//
//   npx tsx --env-file=.env cli.ts            setup → scrape → review sounds → talk (mic)
//   npx tsx --env-file=.env cli.ts --type     same, but type the talk instead of speaking
//   (extra flags like --speed 10 are passed through to predict.ts)
//
// Flow = the spec's user flow: keywords + theme + layers + density → Scrape builds the library →
// you review/preview/remove sounds → predict.ts runs the talk and plays the sounds out loud.
// Everything lives in sessions/<id>/ (setup.json, library.json, sounds/), the same shape Convex's
// library.forSession returns, so a session id can later point at Convex instead of a folder.

import * as readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSoundLibrary, expandLibrary, startPlans } from "./scripts/buildLibrary";
import { DEFAULT_OPTS } from "./convex/lib/pipeline";
// preview: one afplay process at a time, cut after 6 s so long music beds don't run on
let previewProc: ReturnType<typeof spawn> | null = null;
const stopPreview = () => { previewProc?.kill(); previewProc = null; };
const preview = (file: string) => {
  stopPreview();
  const p = spawn("afplay", ["-v", "0.8", file], { stdio: "ignore" });
  p.on("error", () => console.log("   (afplay not found; preview needs macOS)"));
  previewProc = p;
  setTimeout(() => p.kill(), 6000);
};
import type { SetupInput } from "./convex/lib/types";

const SESSIONS = "sessions";
const passthrough = process.argv.slice(2);
const typeMode = passthrough.includes("--type");
// One queue for all input: lines typed (or piped) while a slow step runs are kept, and EOF just means "defaults".
const rl = readline.createInterface({ input: process.stdin });
const queue: string[] = [];
let waiter: ((l: string | null) => void) | null = null;
let closed = false;
rl.on("line", l => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
rl.on("close", () => { closed = true; waiter?.(null); });
const nextLine = () => new Promise<string | null>(r => (queue.length ? r(queue.shift()!) : closed ? r(null) : (waiter = r)));
const ask = async (q: string, def = "") => {
  process.stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
  const a = await nextLine();
  if (!process.stdin.isTTY) console.log(a ?? ""); // echo when input is piped
  return (a ?? "").trim() || def;
};
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
// --first-batch 0 scrapes everything before the talk (the old behaviour)
const flagVal = (name: string, def: string) => { const i = passthrough.indexOf(`--${name}`); return i >= 0 && passthrough[i + 1] ? passthrough[i + 1] : def; };
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;

type Rec = { id: string; slotId: string; layer: string; label: string; source: string; durationMs: number; license: string; url: string; [k: string]: unknown };

function listSessions(): string[] {
  if (!existsSync(SESSIONS)) return [];
  return readdirSync(SESSIONS).filter(d => existsSync(join(SESSIONS, d, "library.json"))).sort().reverse();
}

async function setup(): Promise<{ dir: string; meta: any }> {
  const old = listSessions();
  console.log(bold("\nQuick setup") + dim("  (the AI plans and scrapes the sounds from your theme)"));
  if (old.length) console.log(dim("   saved sessions you can reuse by typing their name: " + old.slice(0, 5).join(", ")));
  let themeIn = "";
  while (!themeIn) {
    themeIn = await ask("What is your talk about? (type a short theme, e.g. 'funny dinner disaster')");
    if (themeIn === "" && closed) throw new Error("No theme given");
    if (old.includes(themeIn)) {
      const dir = join(SESSIONS, themeIn);
      return { dir, meta: JSON.parse(readFileSync(join(dir, "setup.json"), "utf8")) };
    }
  }
  // ┌─ FRONT-END NOTE ───────────────────────────────────────────────────────────────────────────────────────┐
  // │ In the terminal, pressing ENTER on the theme is the "go" signal: planning AND fetching start right here, │
  // │ while the remaining questions are still being answered.                                                  │
  // │ When the front end is integrated this trigger must become a PRESS-AND-HOLD VOICE MESSAGE: transcribe    │
  // │ the held message as the theme and start the scrape the moment the user RELEASES the button (or, better, │
  // │ on the first transcript that already contains the topic). Everything below the trigger stays the same.  │
  // └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  const first = Number(flagVal("first-batch", "6"));
  const layers = { music: true, sfx: true, voice: false };
  const density = "expressive" as SetupInput["density"];
  // moods and default sounds are left empty on purpose: the planner (Claude) chooses them from the theme and description
  const input: SetupInput = { prompt: themeIn, keywords: [], theme: themeIn, moods: [], themeSfx: [], layers, density };
  const id = `${themeIn.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "talk"}_${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}`;
  const dir = join(SESSIONS, id);
  mkdirSync(dir, { recursive: true });
  // ElevenLabs only fills gaps the search couldn't: "sfx" generated an extra variant of EVERY effect and used up the credits
  const generate = "fallback" as const;
  // progress is held back while questions are on screen (it would scribble over the prompt), then shown
  let showProgress = false, lastProgress = "";
  const progress = (e: { completed: number; total: number; message: string }) => {
    lastProgress = `\r   [${e.completed}/${e.total}] ${e.message}`.padEnd(70);
    if (showProgress) process.stdout.write(lastProgress);
  };
  const t0 = Date.now();
  const build = buildSoundLibrary(input, dir, progress,
    { ...DEFAULT_OPTS, generate, variants: 2, concurrency: 4, budgetMs: 240_000 }, first, startPlans(input, first))
    .then(() => null, (e: unknown) => e); // an error is reported after the questions, not in the middle of them

  console.log(dim("   (building your sound library in the background while you answer)"));
  const minutes = Number(await ask("How many minutes will you talk?", "3")) || 3;
  const keywords = (await ask("Sound effects you want, comma separated (e.g. footsteps, door, thunder) — Enter lets the AI choose", "")).split(",").map(s => s.trim()).filter(Boolean);
  // everything else is a default, not a question: music + sfx on, voice off, expressive density, ElevenLabs adds one variant per effect
  const summary = themeIn, tone = "follow the story";
  const meta = { summary, keywords, tone, density, minutes, theme: themeIn, layers };

  console.log("\n" + bold("Building your sound library") + dim("  (batch 1: opening music + 6 likeliest sounds; the rest loads while you talk)"));
  showProgress = true; if (lastProgress) process.stdout.write(lastProgress);
  const err = await build;
  if (err) throw err;
  if (keywords.length) {
    // the sounds you asked for by name: one small extra round (plans only those), added to the same library
    process.stdout.write(`\r   adding your sound effects: ${keywords.join(", ")}`.padEnd(70));
    const lib = JSON.parse(readFileSync(join(dir, "library.json"), "utf8"));
    await expandLibrary(`The speaker explicitly asked for these sound effects: ${keywords.join(", ")}`,
      new Set((lib.sounds as Rec[]).map(s => String(s.slotId))), dir, undefined, keywords).catch(() => []);
  }
  console.log(dim(`\n   ready in ${((Date.now() - t0) / 1000).toFixed(0)} s`));
  console.log();
  writeFileSync(join(dir, "setup.json"), JSON.stringify(meta, null, 2));
  return { dir, meta };
}

// Review step: list every stored sound, preview it, drop the ones you don't want.
async function review(dir: string) {
  const file = join(dir, "library.json");
  const lib = JSON.parse(readFileSync(file, "utf8"));
  const show = () => {
    console.log("\n" + bold("5. Review the library"));
    console.table(Object.fromEntries((lib.sounds as Rec[]).map((s, i) => [i + 1, {
      sound: s.id, layer: s.layer, label: s.label, source: s.source, sec: +(s.durationMs / 1000).toFixed(1), license: s.license,
    }])));
    console.log(dim("   play N   preview · rm N   remove · list   show again · done   start the talk"));
  };
  show();
  for (;;) {
    const [cmd, arg] = (await ask(">", "done")).split(/\s+/);
    const n = Number(arg) - 1;
    const s: Rec | undefined = lib.sounds[n];
    if (cmd === "done" || cmd === "") break;
    else if (cmd === "list") show();
    else if (!s) console.log("   no such number");
    else if (cmd === "play") preview(join(dir, s.url.replace(/^\//, "")));
    else if (cmd === "rm") {
      lib.sounds.splice(n, 1);
      console.log(`   removed ${s.id}`);
      show();
    } else console.log("   commands: play N, rm N, list, done");
  }
  stopPreview();
  // keep the id lists consistent with what is left
  const left = new Set((lib.sounds as Rec[]).map(s => s.slotId));
  lib.sfxIds = lib.sfxIds.filter((x: string) => left.has(x));
  lib.voiceIds = lib.voiceIds.filter((x: string) => left.has(x));
  writeFileSync(file, JSON.stringify(lib, null, 2));
  const slots = [...left];
  console.log(`   ${lib.sounds.length} sounds in ${slots.length} slots kept.`);
}

async function main() {
  console.log(bold("\nSyncopation — terminal mode\n"));
  const { dir, meta } = await setup();
  if (passthrough.includes("--review")) await review(dir); // optional: preview / remove sounds
  const web = passthrough.includes("--web") && (await ask("Use the browser mixer instead of the built-in DJ mixer? (yes/no)", "no")).startsWith("y");
  console.log(dim("\n   Headphones recommended: the mic would otherwise hear the soundtrack and transcribe it."));
  console.log(dim("   Start talking when you hear the music. Ctrl+C or /end to finish.\n"));
  rl.close();
  const mode = typeMode ? "type" : "mic";
  // pick any microphone: npm run dev -- --mic "Shure MV7"   (names: npm run mics), or MIC_DEVICE=... in .env
  const micArg = flagVal("mic", "");
  if (mode === "mic" && micArg) {
    process.env.MIC_DEVICE = micArg;
    const ok = spawnSync("sox", ["-q", "-t", "coreaudio", micArg, "-n", "trim", "0", "0.1"], { stdio: "ignore" }).status === 0;
    console.log(ok ? dim(`   Mic: ${micArg}`) : `   ⚠ couldn't open the mic "${micArg}" — check the exact name with: npm run mics`);
  } else if (mode === "mic" && process.env.MIC_DEVICE) console.log(dim(`   Mic: ${process.env.MIC_DEVICE} (from .env)`));
  if (mode === "mic" && process.platform === "darwin" && !process.env.MIC_DEVICE) {
    // AirPods as the mic force the low-quality call profile and can silence playback → use the laptop mic.
    const probe = spawnSync("sox", ["-q", "-t", "coreaudio", "MacBook Pro Microphone", "-n", "trim", "0", "0.1"], { stdio: "ignore" });
    if (probe.status === 0) {
      process.env.MIC_DEVICE = "MacBook Pro Microphone";
      console.log(dim("   Mic: MacBook Pro Microphone (keeps AirPods in high-quality playback mode)."));
    }
  }

  const args = ["tsx", "--env-file=.env", "predict.ts", "--library", join(dir, "library.json"), "--setup", join(dir, "setup.json"),
    ...passthrough.filter((a, i) => !["--type", "--no-web", "--web", "--first-batch", "--mic"].includes(a) && !["--first-batch", "--mic"].includes(passthrough[i - 1])), ...(mode === "type" ? ["--type"] : []), ...(web ? ["--web"] : [])];
  const child = spawn("npx", args, { stdio: "inherit" });
  child.on("exit", code => process.exit(code ?? 0));
  process.on("SIGINT", () => { /* forwarded to the child through the shared terminal */ });
  void meta;
}

main().catch(e => { console.error(e); process.exit(1); });
