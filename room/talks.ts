// room/talks.ts — runs the talk for each room on the server, so the presenter needs only a phone.
//
//   setup     host sends a theme (+ minutes, wanted sounds) → the scraper builds sessions/<id>/ like cli.ts does,
//             or the host picks a saved session
//   ready     the sounds are in the room's asset list; phones load them
//   running   host pressed Start: one predict.ts child per room (its state is module-global, so one process each),
//             lines go in on its stdin, sound decisions come back over IPC (talkBridge.ts) to this room's engine
//   ended     /end, the child exited, or the room closed (the child is killed)
//
// Input for now is typed on the host page (host.say). Step 3 feeds the host phone's microphone in through the same say().

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "./protocol.js";
import { RoomEngine } from "./engine";
import { applyBridge } from "./talkBridge";
import type { RoomManager } from "./rooms";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Phases in which the host may (re)choose the story: before a talk, after a failure, and after a talk ended (same room, next talk). */
const canChoose = (p: TalkPhase) => p === "setup" || p === "failed" || p === "ready" || p === "ended";
const SESSION_RE = /^[a-z0-9_]{1,64}$/;
const ANSI = /\x1b\[[0-9;]*m/g;

export type TalkPhase = "setup" | "building" | "ready" | "running" | "ended" | "failed";
export type TalkSetup = { theme: string; minutes?: number; sounds?: string };
/** Builds a sound library into dir; reports progress. Replaceable in tests (the real one needs API keys). */
export type BuildFn = (setup: TalkSetup, dir: string, progress: (e: { completed: number; total: number; message: string }) => void) => Promise<void>;
/** Starts the talk process. Replaceable in tests. */
export type SpawnFn = (args: { library: string; setup: string }) => ChildProcess;

type Talk = {
  roomId: string; engine: RoomEngine; phase: TalkPhase; sessionId?: string; sessionDir?: string; theme?: string;
  progress?: { completed: number; total: number; message: string }; error?: string; child?: ChildProcess; keyterms?: string[];
  log: string[]; sentAt: number; pendingLog: string[]; timer?: ReturnType<typeof setTimeout>;
};

export class TalkManager {
  private talks = new Map<string, Talk>();
  readonly sessionsDir: string;
  private build: BuildFn;
  private spawnTalk: SpawnFn;
  constructor(private manager: RoomManager, opts: { sessionsDir?: string; build?: BuildFn; spawnTalk?: SpawnFn; maxRunning?: number } = {}) {
    this.sessionsDir = resolve(opts.sessionsDir ?? join(ROOT, "sessions"));
    this.build = opts.build ?? buildWithScraper;
    this.spawnTalk = opts.spawnTalk ?? spawnPredict;
    this.maxRunning = opts.maxRunning ?? 3;
  }
  private maxRunning: number;

  /** RoomManager hooks: one talk per room. */
  hooks() {
    return {
      created: (id: string) => {
        const engine = new RoomEngine(id);
        engine.manager = this.manager;
        this.talks.set(id, { roomId: id, engine, phase: "setup", log: [], sentAt: 0, pendingLog: [] });
        this.push(id);
      },
      hostConnected: (id: string) => this.push(id, true),
      start: (id: string) => this.start(id),
      closed: (id: string) => { const t = this.talks.get(id); t?.child?.kill(); this.talks.delete(id); },
      host: (id: string, msg: any) => {
        switch (msg.type) {
          case "host.setup": return void this.setup(id, { theme: msg.theme, minutes: msg.minutes, sounds: msg.sounds });
          case "host.useSession": return void this.useSession(id, msg.sessionId);
          case "host.say": return void this.say(id, msg.text);
          case "host.command": return void this.command(id, msg.command);
        }
      },
    };
  }

  /** For the HTTP handler: an audio URL belongs to whichever room registered it. */
  fileForUrl(path: string) {
    for (const t of this.talks.values()) { const f = t.engine.registry.fileForUrl(path); if (f) return f; }
    return null;
  }

  phase(roomId: string) { return this.talks.get(roomId)?.phase; }

  // ---------------------------------------------------------------- setup
  async setup(roomId: string, setup: TalkSetup) {
    const t = this.talks.get(roomId);
    if (!t || !canChoose(t.phase)) return false;
    const theme = setup.theme.trim();
    const id = `${theme.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "talk"}_${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}`;
    const dir = join(this.sessionsDir, id);
    Object.assign(t, { phase: "building", sessionId: id, sessionDir: dir, theme, error: undefined, progress: { completed: 0, total: 1, message: "planning the sounds" } });
    this.push(roomId);
    try {
      mkdirSync(dir, { recursive: true });
      await this.build(setup, dir, e => { t.progress = e; this.push(roomId); });
      if (!this.talks.has(roomId)) return false;  // room closed while building
      const minutes = setup.minutes ?? 3;
      const keywords = (setup.sounds ?? "").split(",").map(s => s.trim()).filter(Boolean);
      // the same setup.json cli.ts writes, so predict.ts reads it unchanged
      writeFileSync(join(dir, "setup.json"), JSON.stringify({
        summary: theme, keywords, tone: "follow the story", density: "expressive", minutes, theme, layers: { music: true, sfx: true, voice: false },
      }, null, 2));
      this.ready(t);
      return true;
    } catch (e) {
      t.phase = "failed"; t.error = (e as Error).message?.slice(0, 300) || "building the sounds failed";
      this.push(roomId);
      return false;
    }
  }

  /** Reuse a session built earlier (no scraping, no API calls). */
  useSession(roomId: string, sessionId: string) {
    const t = this.talks.get(roomId);
    if (!t || !SESSION_RE.test(sessionId) || !canChoose(t.phase)) return false;
    const dir = join(this.sessionsDir, sessionId);
    if (!existsSync(join(dir, "library.json")) || !existsSync(join(dir, "setup.json"))) return false;
    let theme = sessionId;
    try { theme = JSON.parse(readFileSync(join(dir, "setup.json"), "utf8")).theme || sessionId; } catch { /* keep the id */ }
    Object.assign(t, { sessionId, sessionDir: dir, theme, error: undefined });
    this.ready(t);
    return true;
  }

  /** Saved sessions a host can reuse, newest first. */
  savedSessions(limit = 12): { id: string; theme: string }[] {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir)
      .filter(d => SESSION_RE.test(d) && existsSync(join(this.sessionsDir, d, "library.json")) && existsSync(join(this.sessionsDir, d, "setup.json")))
      .map(d => ({ d, at: statSync(join(this.sessionsDir, d, "library.json")).mtimeMs }))
      .sort((a, b) => b.at - a.at).slice(0, limit)
      .map(({ d }) => { let theme = d; try { theme = JSON.parse(readFileSync(join(this.sessionsDir, d, "setup.json"), "utf8")).theme || d; } catch { } return { id: d, theme }; });
  }

  private ready(t: Talk) {
    const sounds = join(t.sessionDir!, "sounds");
    const files = existsSync(sounds) ? readdirSync(sounds).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f)).map(f => join(sounds, f)) : [];
    // a fresh engine per story: phones download only this story's sounds, not every story chosen in this room
    t.engine = new RoomEngine(t.roomId);
    t.engine.manager = this.manager;
    this.manager.setManifest(t.roomId, []);
    t.engine.register(files);
    t.phase = "ready"; t.progress = undefined;
    this.push(t.roomId);
  }

  // ---------------------------------------------------------------- running
  start(roomId: string) {
    const t = this.talks.get(roomId);
    if (!t) return false;
    if (t.phase !== "ready" || !t.sessionDir) {
      if (t.phase !== "running") { t.error = "Set up the story's sounds first."; this.push(roomId); }
      return false;
    }
    if ([...this.talks.values()].filter(x => x.phase === "running").length >= this.maxRunning) {
      t.error = "The server is running as many talks as it can. Try again shortly."; this.push(roomId); return false;
    }
    const child = this.spawnTalk({ library: join(t.sessionDir, "library.json"), setup: join(t.sessionDir, "setup.json") });
    t.child = child; t.phase = "running"; t.error = undefined;
    t.engine.begin();
    const within = resolve(t.sessionDir) + sep;
    child.on("message", (m: any) => {
      if (m?.op === "keyterms" && Array.isArray(m.terms)) { t.keyterms = m.terms.filter((x: unknown) => typeof x === "string" && x.length <= 60).slice(0, 200); return; }
      applyBridge(t.engine, m, within);
    });
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/); buf = lines.pop() ?? "";
      for (const l of lines) { const clean = l.replace(ANSI, "").trimEnd(); if (clean) this.logLine(t, clean); }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const startedAt = Date.now();
    child.on("exit", code => {
      if (t.child !== child) return;
      t.child = undefined; t.phase = "ended";
      if (code && code !== 0) t.error = `The talk stopped unexpectedly (exit ${code}).`;
      // gone within seconds = it never really started (e.g. no API key): say why, from its last words
      else if (Date.now() - startedAt < 10_000) t.error = `The talk stopped right away: ${t.log[t.log.length - 1] ?? "no output"}`;
      t.engine.stopAll();
      this.push(roomId);
    });
    child.on("error", e => { t.error = `Couldn't start the talk: ${e.message}`; });
    this.push(roomId);
    return true;
  }

  /** One sentence of the talk. Never a command: a leading "/" is dropped so speech can't steer the engine. */
  say(roomId: string, text: string) {
    const t = this.talks.get(roomId);
    const line = text.replace(/[\r\n]+/g, " ").replace(/^\s*\/+/, "").trim();
    if (!t?.child?.stdin || t.phase !== "running" || !line) return false;
    t.child.stdin.write(line + "\n");
    return true;
  }

  /** Spoken words from the host's microphone (room/mic.ts): partial = the sentence so far, final = the finished sentence. */
  hear(roomId: string, op: "partial" | "final", text: string, lagMs = 0) {
    const t = this.talks.get(roomId);
    if (!t?.child?.connected || t.phase !== "running" || !text.trim()) return false;
    t.child.send({ op, text: text.slice(0, 1000), lagMs });
    return true;
  }
  keytermsFor(roomId: string) { return this.talks.get(roomId)?.keyterms ?? []; }

  /** The presenter's buttons: wrong sound (/skip), good sound (/good), end the talk (/end). */
  command(roomId: string, cmd: "skip" | "good" | "end" | "status") {
    const t = this.talks.get(roomId);
    if (!t?.child?.stdin || t.phase !== "running") return false;
    t.child.stdin.write(`/${cmd}\n`);
    return true;
  }

  // ---------------------------------------------------------------- host view
  private logLine(t: Talk, line: string) {
    t.log.push(line); if (t.log.length > 200) t.log.splice(0, t.log.length - 200);
    t.pendingLog.push(line);
    if (!t.timer) t.timer = setTimeout(() => { t.timer = undefined; this.push(t.roomId); }, 300); // batch chatty output
  }

  /** Send the host what it needs to draw the talk panel. full = everything (a host that just (re)connected). */
  private push(roomId: string, full = false) {
    const t = this.talks.get(roomId);
    if (!t) return;
    const lines = full ? t.log.slice(-60) : t.pendingLog;
    t.pendingLog = [];
    this.manager.sendToHost(roomId, {
      protocolVersion: PROTOCOL_VERSION, type: "talk.status", phase: t.phase, theme: t.theme, sessionId: t.sessionId,
      progress: t.progress, error: t.error, sounds: t.engine.registry.list().length,
      ...(canChoose(t.phase) ? { saved: this.savedSessions() } : {}),
      log: lines, logReset: full,
    });
  }
}

// ---------------------------------------------------------------- real implementations
/** The scraper, as cli.ts runs it: plan + first batch now, the rest while the talk runs (predict.ts loadBatch2). */
const buildWithScraper: BuildFn = async (setup, dir, progress) => {
  const { buildSoundLibrary, expandLibrary, startPlans } = await import("../scripts/buildLibrary");
  const { DEFAULT_OPTS } = await import("../convex/lib/pipeline");
  const input = { prompt: setup.theme, keywords: [], theme: setup.theme, moods: [], themeSfx: [], layers: { music: true, sfx: true, voice: false }, density: "expressive" as const };
  const first = 6;
  await buildSoundLibrary(input, dir, progress, { ...DEFAULT_OPTS, generate: "fallback", variants: 2, concurrency: 4, budgetMs: 240_000 }, first, startPlans(input, first));
  const wanted = (setup.sounds ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (wanted.length) {
    progress({ completed: 1, total: 1, message: `adding your sounds: ${wanted.join(", ")}` });
    const lib = JSON.parse(readFileSync(join(dir, "library.json"), "utf8"));
    await expandLibrary(`The speaker explicitly asked for these sound effects: ${wanted.join(", ")}`,
      new Set((lib.sounds as { slotId: string }[]).map(s => String(s.slotId))), dir, undefined, wanted).catch(() => []);
  }
};

/** predict.ts in typed mode, its sound going to this server over IPC. Keys come from this process's environment. */
const spawnPredict: SpawnFn = ({ library, setup }) =>
  spawn(process.execPath, ["--import", "tsx", "predict.ts", "--library", library, "--setup", setup, "--type"], {
    cwd: ROOT, stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, SYNC_ROOM_IPC: "1", FORCE_COLOR: "0" },
  });
