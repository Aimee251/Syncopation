// scripts/roomDemo.ts — try a speaker room without a talk, a mic or any API key: a scripted soundtrack from a saved session.
//
//   npx tsx scripts/roomDemo.ts --session sessions/spooky_story_10242116
//
// Open the printed address on phones on the same Wi-Fi: one taps Share a story → Become host, the others Join a story.
// When the host presses Start talk the script plays (music, effects, a mood change, ducking) and repeats every 40 s.
// It goes through the same engine calls predict.ts makes via mixer.ts, so what the phones do here is what a real talk does.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { startRoomHost } from "../room/host";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const dir = arg("session");
if (!dir) { console.error("usage: npx tsx scripts/roomDemo.ts --session sessions/<id>"); process.exit(1); }
const soundsDir = join(dir, "sounds");
const files = readdirSync(soundsDir).filter(f => /\.(mp3|wav|ogg)$/i.test(f)).map(f => join(soundsDir, f));
const pick = (re: RegExp) => files.find(f => re.test(f));

const room = await startRoomHost({ files, port: Number(arg("port") ?? 5176), log: m => console.log(`[room] ${m}`) });
console.log(`${files.length} sounds from ${soundsDir}`);
console.log(`Open on phones (same Wi-Fi): ${room.urls.join("  or  ")}`);
console.log("Waiting for the host to press Start talk…");
await room.engine.started;
console.log("Started.");

const e = room.engine;
const music = files.filter(f => /music/i.test(f));
const effects = files.filter(f => !/music|drone|amb/i.test(f));
const at = (s: number, label: string, fn: () => void) => setTimeout(() => { console.log(`  ${s.toString().padStart(2)} s  ${label}`); fn(); }, s * 1000);

function play() {
  const calm = pick(/calm/) ?? music[0], tense = pick(/tense|terror/) ?? music[1] ?? music[0];
  const fx = (re: RegExp, i: number) => pick(re) ?? effects[i % Math.max(1, effects.length)];
  at(0, "music bed (calm)", () => e.setLoop("music", calm, 0.35));
  at(4, "one-shot: footsteps", () => e.playOnce(fx(/footstep/, 0), 0.8));
  at(7, "presenter speaking → beds duck", () => e.duck(2500));
  at(8, "one-shot: door", () => e.playOnce(fx(/door/, 1), 0.8));
  at(12, "mood change → crossfade to tense music", () => e.setLoop("music", tense, 0.45));
  at(18, "one-shot: thunder", () => e.playOnce(fx(/thunder/, 2), 0.9));
  at(21, "one-shot: hit", () => e.playOnce(fx(/hit/, 3), 0.9));
  at(24, "music level up", () => e.setLevel("music", 0.6));
  at(32, "everything fades out", () => e.stopAll());
}
play();
setInterval(play, 40_000);
