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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSoundLibrary, startPlans } from "./scripts/buildLibrary";
import { DEFAULT_OPTS, resetProviderHealth } from "./convex/lib/pipeline";
import type { SetupInput } from "./convex/lib/types";

const PORT = Number(process.env.PORT || 8787);
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

const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) => new Promise<any>(resolve => {
  let s = "";
  req.on("data", c => (s += c));
  req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } });
});

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  try {
    if (req.method === "POST" && url.pathname === "/api/start") {
      const { theme } = await readBody(req);
      if (!String(theme ?? "").trim()) return send(res, 400, { error: "no theme" });
      return send(res, 200, { id: startJob(String(theme).trim()).id });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const job = jobs.get(url.searchParams.get("id") || "");
      if (!job) return send(res, 404, { error: "unknown session" });
      return send(res, 200, { state: job.state, done: job.done, total: job.total, error: job.error, seconds: Math.round((Date.now() - job.t0) / 1000) });
    }
    if (req.method === "POST" && url.pathname === "/api/talk") {
      const { id, minutes } = await readBody(req);
      const job = jobs.get(id);
      if (!job || job.state !== "ready") return send(res, 409, { error: "library not ready" });
      startTalk(job, Number(minutes) || 3);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      stopTalk();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(PORT, () => console.log(`[app] backend on http://localhost:${PORT}`));

// the web app (Vite) in the same terminal; /api is proxied to this server (web/vite.config.js)
let web: ChildProcess | null = null;
if (!process.argv.includes("--no-web") && existsSync("web/package.json")) {
  if (!existsSync("web/node_modules")) spawnSync("npm", ["--prefix", "web", "install"], { stdio: "inherit" });
  web = spawn("npm", ["--prefix", "web", "run", process.argv.includes("--phone") ? "dev:phone" : "dev"], { stdio: "inherit" });
}

process.on("SIGINT", () => {
  const talking = Boolean(talk);
  stopTalk();
  web?.kill("SIGINT");
  setTimeout(() => process.exit(0), talking ? 3000 : 1500); // time for the talk's report
});
