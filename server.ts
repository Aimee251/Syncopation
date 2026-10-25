// server.ts — connects the web app (web/) to the backend.
//
//   npm run app                    this server on :8787 + the web app on :5173 (open the URL Vite prints)
//   npm run app -- --mic "Name"    use another microphone for the talk (names: npm run mics)
//
// Flow:
//   1. hold & speak the theme → release → POST /api/start {theme}: planning + scraping start right away
//   2. the user turns the wheel meanwhile; the loader polls GET /api/status?id=… until batch 1 is in
//   3. POST /api/talk {id, minutes}: predict.ts runs the talk (laptop mic in, sounds out of the laptop);
//      batch 2 and the live top-ups keep loading inside predict.ts, like with `npm run dev`
//   4. tap the page → POST /api/stop: sends /end (report printed here, learned weights saved)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomInt } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { buildSoundLibrary, startPlans } from "./scripts/buildLibrary";
import { DEFAULT_OPTS, resetProviderHealth } from "./convex/lib/pipeline";
import type { SetupInput } from "./convex/lib/types";

const PORT = Number(process.env.PORT || 8787);
const SHARE = process.argv.includes("--share");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };
function serveWeb(pathname: string, res: ServerResponse) {
  const root = resolve("web/dist");
  let file = resolve(root, "." + decodeURIComponent(pathname));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html"); // the app's own pages
  if (!existsSync(file)) { res.writeHead(503); return res.end("web page not built yet"); }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}
const FIRST_BATCH = 8; // concrete events the speaker is likely to name early (planner.ts) + 1 ambience
const layers = { music: true, sfx: true, voice: false };

type Job = { id: string; dir: string; theme: string; state: "building" | "ready" | "error"; done: number; total: number; error?: string; t0: number };
const jobs = new Map<string, Job>();
let talk: ChildProcess | null = null;

// 1. the theme is in: plan + batch 1 (same settings as the terminal setup in cli.ts)
function startJob(theme: string): Job {
  const slug = theme.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "talk";
  const id = `${slug}_${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}`;
  const dir = join("sessions", id);
  mkdirSync(dir, { recursive: true });
  const input: SetupInput = { prompt: theme, keywords: [], theme, moods: [], themeSfx: [], layers, density: "expressive" };
  const job: Job = { id, dir, theme, state: "building", done: 0, total: 0, t0: Date.now() };
  jobs.set(id, job);
  resetProviderHealth();
  console.log(`\n[app] theme: "${theme}" → building ${dir}`);
  buildSoundLibrary(input, dir, e => { job.done = e.completed; job.total = e.total; },
    { ...DEFAULT_OPTS, generate: "fallback", variants: 2, concurrency: 6, budgetMs: 240_000 }, FIRST_BATCH, startPlans(input, FIRST_BATCH))
    .then(() => {
      const n = JSON.parse(readFileSync(join(dir, "library.json"), "utf8")).sounds?.length ?? 0;
      if (!n) throw new Error("No sounds could be fetched. Check the API keys: npm run keys");
      job.state = "ready";
      console.log(`[app] ${n} sounds ready in ${((Date.now() - job.t0) / 1000).toFixed(0)} s`);
    })
    .catch((e: unknown) => { job.state = "error"; job.error = e instanceof Error ? e.message : String(e); console.error("[app] build failed:", job.error); });
  return job;
}

// same microphone rules as cli.ts: --mic / MIC_DEVICE, else the MacBook mic (AirPods as mic ruin playback quality)
const micFlag = process.argv.indexOf("--mic");
if (micFlag >= 0 && process.argv[micFlag + 1]) process.env.MIC_DEVICE = process.argv[micFlag + 1];
if (process.platform === "darwin" && !process.env.MIC_DEVICE &&
  spawnSync("sox", ["-q", "-t", "coreaudio", "MacBook Pro Microphone", "-n", "trim", "0", "0.1"], { stdio: "ignore" }).status === 0)
  process.env.MIC_DEVICE = "MacBook Pro Microphone";

// 3. the talk itself
function startTalk(job: Job, minutes: number) {
  stopTalk();
  writeFileSync(join(job.dir, "setup.json"), JSON.stringify({
    summary: job.theme, keywords: [], tone: "follow the story", density: "expressive", minutes, theme: job.theme, layers,
  }, null, 2));
  console.log(`[app] talk started (${minutes} min, mic: ${process.env.MIC_DEVICE || "system default"})`);
  const child = spawn(join("node_modules", ".bin", "tsx"),
    ["--env-file=.env", "predict.ts", "--library", join(job.dir, "library.json"), "--setup", join(job.dir, "setup.json")],
    { stdio: ["pipe", "inherit", "inherit"] });
  child.on("exit", () => { if (talk === child) talk = null; });
  talk = child;
}
// 4. /end prints the report and saves the weights; Ctrl+C-style stop if it hangs
function stopTalk() {
  const child = talk;
  if (!child) return;
  talk = null;
  child.stdin?.write("/end\n");
  setTimeout(() => child.kill("SIGINT"), 5000).unref();
}

// the deployed page (Vercel) calls this server through a tunnel from another site: allow that (no cookies, no secrets in replies)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, ngrok-skip-browser-warning",
};
// STORY ROOMS: the storyteller creates a room and gets a random code; listeners join with it and follow the same talk
// (they land on the talk page when it starts, with the same timer). One laptop runs one talk at a time.
type Room = { code: string; state: "waiting" | "live" | "ended"; startedAt: number; theme: string; jobId: string; touched: number };
const rooms = new Map<string, Room>();
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L: easy to read out loud and type
function newRoom(): Room {
  for (const [c, r] of rooms) if (Date.now() - r.touched > 6 * 3600_000) rooms.delete(c); // forget rooms idle for 6 h
  let code = "";
  do code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join(""); while (rooms.has(code));
  const room: Room = { code, state: "waiting", startedAt: 0, theme: "", jobId: "", touched: Date.now() };
  rooms.set(code, room);
  console.log(`[app] room ${code} created`);
  return room;
}
const roomOf = (code: unknown) => rooms.get(String(code ?? "").trim().toUpperCase());

const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) => new Promise<any>(resolve => {
  let s = "";
  req.on("data", c => (s += c));
  req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } });
});

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  try {
    if (req.method === "POST" && url.pathname === "/api/start") {
      const { theme, room: code } = await readBody(req);
      if (!String(theme ?? "").trim()) return send(res, 400, { error: "no theme" });
      const room = roomOf(code);
      const job = startJob(String(theme).trim());
      if (room) Object.assign(room, { theme: job.theme, jobId: job.id, touched: Date.now(), state: room.state === "live" ? "live" : "waiting" });
      return send(res, 200, { id: job.id });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const job = jobs.get(url.searchParams.get("id") || "");
      if (!job) return send(res, 404, { error: "unknown session" });
      return send(res, 200, { state: job.state, done: job.done, total: job.total, error: job.error, seconds: Math.round((Date.now() - job.t0) / 1000) });
    }
    if (req.method === "POST" && url.pathname === "/api/talk") {
      const { id, minutes, room: code } = await readBody(req);
      const job = jobs.get(id);
      if (!job || job.state !== "ready") return send(res, 409, { error: "library not ready" });
      startTalk(job, Number(minutes) || 3);
      // this laptop runs one talk: any other live room has ended; this one is live from now
      for (const r of rooms.values()) if (r.state === "live") r.state = "ended";
      const room = roomOf(code);
      if (room) Object.assign(room, { state: "live", startedAt: Date.now(), touched: Date.now() });
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      const { room: code } = await readBody(req);
      stopTalk();
      const room = roomOf(code);
      if (room) Object.assign(room, { state: "ended", touched: Date.now() });
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/room") return send(res, 200, { code: newRoom().code });
    if (req.method === "GET" && url.pathname.startsWith("/api/room/")) {
      const room = roomOf(decodeURIComponent(url.pathname.slice("/api/room/".length)));
      if (!room) return send(res, 404, { error: "no story with that code" });
      room.touched = Date.now();
      // what listeners see while they wait: the storyteller is still choosing, or the sounds for their theme are loading
      const job = jobs.get(room.jobId);
      const phase = room.state !== "waiting" ? room.state : !job ? "choosing" : "preparing";
      return send(res, 200, { code: room.code, state: room.state, phase, startedAt: room.startedAt, theme: room.theme,
        done: job?.done ?? 0, total: job?.total ?? 0, serverNow: Date.now() });
    }
    // --share: this server also serves the built web page, so ONE address (port 8787) has page + API → one tunnel
    if (SHARE && req.method === "GET" && !url.pathname.startsWith("/api/")) return serveWeb(url.pathname, res);
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(PORT, () => console.log(`[app] backend on http://localhost:${PORT}`));

// the web app (Vite) in the same terminal; /api is proxied to this server (web/vite.config.js)
let web: ChildProcess | null = null;
if (SHARE) {
  // build the page once (vite build → web/dist); it's then served by this server at http://127.0.0.1:8787
  if (!existsSync("web/node_modules")) spawnSync("npm", ["--prefix", "web", "install"], { stdio: "inherit" });
  const b = spawnSync("npm", ["--prefix", "web", "run", "build"], { stdio: "inherit" });
  console.log(b.status === 0
    ? `\n[app] web page + backend on http://127.0.0.1:${PORT}\n[app] share it:  cloudflared tunnel --url http://127.0.0.1:${PORT}\n`
    : "[app] web page build failed (see above)");
} else if (!process.argv.includes("--no-web") && existsSync("web/package.json")) {
  if (!existsSync("web/node_modules")) spawnSync("npm", ["--prefix", "web", "install"], { stdio: "inherit" });
  web = spawn("npm", ["--prefix", "web", "run", process.argv.includes("--phone") ? "dev:phone" : "dev"], { stdio: "inherit" });
}

process.on("SIGINT", () => {
  const talking = Boolean(talk);
  stopTalk();
  web?.kill("SIGINT");
  setTimeout(() => process.exit(0), talking ? 3000 : 1500); // time for the talk's report
});
