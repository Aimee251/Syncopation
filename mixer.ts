// mixer.ts — drop-in replacement for player.ts that sends the audio commands to a browser mixer
// (mixer.html, Web Audio) instead of spawning afplay. The browser can crossfade, duck, ramp levels
// smoothly and loop gaplessly, which afplay cannot. Same exports as player.ts, so predict.ts only
// swaps the import. If no browser is connected, every call falls back to player.ts (afplay).
//
//   no dependencies; one HTTP server: GET / (page) · GET /events (SSE commands) · GET /files/… (audio) · POST /ready
//   Commands are plain JSON, so the real output phone can consume the same stream later.

import { createServer, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as player from "./player";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const TYPES: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg" };

const clients = new Set<ServerResponse>();
let ready = false;
const readyWaiters: (() => void)[] = [];
// Last command per bed, replayed to a browser that connects (or refreshes) mid-talk
const state: Record<string, any> = {};
let started = false;
export let mixerUrl = "";

const toUrl = (file: string) => "/files/" + relative(ROOT, resolve(file)).split(sep).map(encodeURIComponent).join("/");
const send = (m: any) => { const line = `data: ${JSON.stringify(m)}\n\n`; clients.forEach(c => c.write(line)); };
/** True while a browser is connected and has clicked Start */
export const mixerActive = () => started && ready && clients.size > 0;

export function startMixer(port = Number(process.env.MIXER_PORT || 5175)): Promise<string> {
  if (started) return Promise.resolve(mixerUrl);
  return new Promise((ok, fail) => {
    const server = createServer((req, res) => {
      const url = decodeURIComponent((req.url || "/").split("?")[0]);
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(join(here, "mixer.html")));
      }
      if (req.method === "GET" && url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": hi\n\n");
        clients.add(res);
        for (const m of Object.values(state)) res.write(`data: ${JSON.stringify(m)}\n\n`);
        const beat = setInterval(() => res.write(": ·\n\n"), 15000);
        req.on("close", () => { clearInterval(beat); clients.delete(res); });
        return;
      }
      if (req.method === "POST" && url === "/ready") {
        ready = true; readyWaiters.splice(0).forEach(w => w());
        res.writeHead(204); return res.end();
      }
      if (req.method === "GET" && url.startsWith("/files/")) {
        const file = resolve(ROOT, url.slice("/files/".length));
        // only audio files inside the project folder
        if (!file.startsWith(ROOT + sep) || !TYPES[extname(file).toLowerCase()] || !existsSync(file)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()], "content-length": statSync(file).size });
        return createReadStream(file).pipe(res);
      }
      res.writeHead(404); res.end();
    });
    server.on("error", e => fail(e));
    server.listen(port, "127.0.0.1", () => { started = true; mixerUrl = `http://localhost:${port}`; ok(mixerUrl); });
    server.unref();
  });
}

/** Opens the page (macOS) and resolves when the browser has clicked Start and its stream is open */
export function waitForBrowser(open = true): Promise<void> {
  if (open) spawn("open", [mixerUrl], { stdio: "ignore" }).on("error", () => { });
  return ready && clients.size ? Promise.resolve() : new Promise(r => readyWaiters.push(r));
}

// ---- same API as player.ts ----
export const playerReady = () => started || player.playerReady();
export const playerName = () => (started ? "browser mixer " + mixerUrl : player.playerName());

export function playOnce(file: string | undefined, volume: number, opts: { role?: string; liftDb?: number; attackMs?: number; releaseMs?: number; maxS?: number; lowpassHz?: number; wet?: number } = {}): boolean {
  if (!mixerActive()) return player.playOnce(file, volume, opts);
  if (!file || !existsSync(file)) return false;
  const v = opts.liftDb !== undefined ? player.fxGainFor(opts.liftDb, state.music?.level ?? state.ambience?.level) : volume;
  send({ type: "sfx", url: toUrl(file), volume: Math.max(0, Math.min(1, v)) });
  return true;
}

export function setLoop(layer: "music" | "ambience", file: string | undefined, volume: number) {
  if (!mixerActive()) return player.setLoop(layer, file, volume);
  if (!file || !existsSync(file)) return;
  const prev = state[layer];
  if (prev?.url === toUrl(file)) return setLevel(layer, volume);
  state[layer] = { type: "bed", layer, url: toUrl(file), level: volume };
  send(state[layer]);
}

export function setLevel(layer: "music" | "ambience", volume: number) {
  if (!mixerActive()) return player.setLevel(layer, volume);
  const cur = state[layer];
  if (!cur || Math.abs(cur.level - volume) < 0.03) return;    // the browser ramps smoothly, so small steps are fine
  cur.level = volume;
  send({ type: "level", layer, level: volume });
}

/** Speech is happening: dip the beds a little so the voice stays clear */
export function duck(ms = 2500) { player.speaking(); if (mixerActive()) send({ type: "duck", ms }); }
export { preload, pickCompatible, setMixLogger, soundProfile, setSpace } from "./player";

export function stopAll() {
  if (mixerActive()) { send({ type: "stop" }); for (const k of Object.keys(state)) delete state[k]; }
  player.stopAll();
}
