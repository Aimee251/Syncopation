// A stand-in for predict.ts in tests: same arguments, same stdin lines, same output tags, and its sound goes through the
// real child side of the bridge (childSink). No API keys, no models.
import * as readline from "node:readline";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { childSink } from "../../room/talkBridge";

const lib = process.argv[process.argv.indexOf("--library") + 1];
const sounds = join(dirname(lib), "sounds");
const files = readdirSync(sounds).map(f => join(sounds, f));
const sink = childSink();
sink.register(files);
const music = files.find(f => /music/.test(f));
sink.setLoop("music", music, 0.3);
console.log("Setup loaded: fake talk");

// like predict.ts in a room: trigger words for the server's speech model, and spoken words arriving over IPC
process.send!({ op: "keyterms", terms: ["thunder", "music calm"] });
process.on("message", (m: any) => {
  if (m?.op === "partial") console.log(`[STREAM] ${m.text}`);
  else if (m?.op === "final") heard(m.text);
});

readline.createInterface({ input: process.stdin }).on("line", line => {
  if (line === "/end") { sink.stopAll(); console.log("timeline: done"); setTimeout(() => process.exit(0), 50); return; }
  if (line.startsWith("/")) return console.log(`[CMD] ${line}`);
  heard(line);
});

function heard(line: string) {
  console.log(`\x1b[36m[HEARD]\x1b[0m ${line}`);
  const hit = files.find(f => line.split(/\s+/).some(w => w.length > 3 && f.includes(w)));
  if (hit) { sink.playOnce(hit, 0.8, { attackMs: 5, releaseMs: 200 }); console.log(`[PLAY] ${hit}`); }
  if (/outside/.test(line)) sink.playOnce(join(dirname(lib), "..", "elsewhere.mp3"), 0.8); // must be refused by the parent
}
