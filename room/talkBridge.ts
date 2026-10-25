// room/talkBridge.ts — the channel between a talk child process (predict.ts) and its room's engine in the server.
// predict.ts keeps its whole state in module globals, so the server runs one child per room. The child's mixer.ts
// talks to childSink() instead of speakers; every call becomes one IPC message that the parent applies with applyBridge().

import { resolve } from "node:path";
import type { RoomEngine, RoomSink } from "./engine";

type Layer = "music" | "ambience";
export type BridgeMsg =
  | { op: "register"; files: string[] }
  | { op: "playOnce"; file: string; gain: number; opts: { attackMs?: number; releaseMs?: number; maxS?: number } }
  | { op: "setLoop"; layer: Layer; file: string | null; level: number }
  | { op: "setLevel"; layer: Layer; level: number }
  | { op: "duck"; ms: number }
  | { op: "stopAll" }
  | { op: "keyterms"; terms: string[] };   // words the speech model should hear right (handled by talks.ts)

/** Parent → child: the host's microphone, transcribed. */
export type HearMsg = { op: "partial" | "final"; text: string; lagMs?: number };

/** In the child: true when the server started this process for a room. */
export const inTalkChild = () => process.env.SYNC_ROOM_IPC === "1" && typeof process.send === "function";

/** In the child: a RoomSink that forwards to the parent. Bed levels are tracked here too, for effect gain maths. */
export function childSink(): RoomSink {
  const levels: Partial<Record<Layer, number>> = {};
  const send = (m: BridgeMsg) => { process.send?.(m); };
  return {
    // absolute paths: the parent only accepts files inside this talk's session folder
    register: files => { const f = files.filter((x): x is string => !!x).map(x => resolve(x)); if (f.length) send({ op: "register", files: f }); },
    playOnce: (file, gain, opts = {}) => {
      if (!file) return false;
      send({ op: "playOnce", file: resolve(file), gain, opts: { attackMs: opts.attackMs, releaseMs: opts.releaseMs, maxS: opts.maxS } });
      return true;
    },
    setLoop: (layer, file, level) => { if (file) levels[layer] = level; else delete levels[layer]; send({ op: "setLoop", layer, file: file ? resolve(file) : null, level }); },
    setLevel: (layer, level) => { if (levels[layer] !== undefined) levels[layer] = level; send({ op: "setLevel", layer, level }); },
    level: layer => levels[layer],
    duck: (ms = 2500) => send({ op: "duck", ms }),
    stopAll: () => { delete levels.music; delete levels.ambience; send({ op: "stopAll" }); },
  };
}

const finite = (v: unknown, lo = 0, hi = 1e6) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isLayer = (v: unknown): v is Layer => v === "music" || v === "ambience";
const isFile = (v: unknown, within: string) => typeof v === "string" && v.length < 1024 && v.startsWith(within);

/**
 * In the parent: apply one message from a child. Checked like any other input: only files inside the talk's own
 * session folder, finite numbers in range, known layers. Returns false for anything it refused.
 */
export function applyBridge(engine: RoomEngine, m: any, sessionDir: string): boolean {
  if (!m || typeof m !== "object") return false;
  switch (m.op) {
    case "register":
      if (!Array.isArray(m.files)) return false;
      engine.register(m.files.filter((f: unknown) => isFile(f, sessionDir)).slice(0, 500));
      return true;
    case "playOnce": {
      if (!isFile(m.file, sessionDir) || !finite(m.gain, 0, 1)) return false;
      const o = m.opts ?? {};
      return engine.playOnce(m.file, m.gain, {
        ...(finite(o.attackMs, 0, 60_000) ? { attackMs: o.attackMs } : {}),
        ...(finite(o.releaseMs, 0, 60_000) ? { releaseMs: o.releaseMs } : {}),
        ...(finite(o.maxS, 0, 600) ? { maxS: o.maxS } : {}),
      });
    }
    case "setLoop":
      if (!isLayer(m.layer) || !finite(m.level, 0, 1) || (m.file !== null && !isFile(m.file, sessionDir))) return false;
      engine.setLoop(m.layer, m.file ?? undefined, m.level);
      return true;
    case "setLevel":
      if (!isLayer(m.layer) || !finite(m.level, 0, 1)) return false;
      engine.setLevel(m.layer, m.level);
      return true;
    case "duck":
      if (!finite(m.ms, 0, 60_000)) return false;
      engine.duck(m.ms);
      return true;
    case "stopAll":
      engine.stopAll();
      return true;
  }
  return false;
}
