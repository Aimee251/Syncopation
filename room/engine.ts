// room/engine.ts — the cue adapter (spec §4): the sound engine's decisions (predict.ts → mixer.ts) become shared room cues.
// Same verbs as player.ts / mixer.ts: one-shot effects, a looping bed per layer, bed levels, ducking, stop.
//
// Two ways to use it:
//   server (room/talks.ts)   one engine per room: `target` is that room from the start, and it plays there once the talk runs
//   laptop (--room, demo)    one engine for the process: it plays in the first room whose host presses Start (hooks())

import type { RoomManager } from "./rooms";
import { AssetRegistry, libraryFor } from "./assets";

type Layer = "music" | "ambience";

/** What mixer.ts needs from a room. RoomEngine is one; in a talk child process it's a proxy to the parent's engine. */
export interface RoomSink {
  register(files: (string | undefined)[]): void;
  playOnce(file: string | undefined, gain: number, opts?: { attackMs?: number; releaseMs?: number; maxS?: number }): boolean;
  setLoop(layer: Layer, file: string | undefined, level: number): void;
  setLevel(layer: Layer, level: number): void;
  level(layer: Layer): number | undefined;
  duck(ms?: number): void;
  stopAll(): void;
}

export class RoomEngine implements RoomSink {
  readonly registry = new AssetRegistry();
  roomId: string | null = null;        // where cues go (set when the talk starts)
  readonly started: Promise<string>;
  private markStarted!: (roomId: string) => void;
  private beds: Record<Layer, { file: string; level: number } | null> = { music: null, ambience: null };
  manager!: RoomManager;
  log: (msg: string) => void = () => { };

  /** @param target the one room this engine belongs to (server mode); omitted = laptop mode */
  constructor(readonly target: string | null = null) { this.started = new Promise(ok => { this.markStarted = ok; }); }

  /** Server mode: the talk is running, cues go to the target room. */
  begin() { if (this.target) { this.roomId = this.target; this.markStarted(this.target); } }

  /** Wire into a RoomManager's hooks. */
  hooks() {
    return {
      created: (id: string) => { this.manager.setManifest(id, this.registry.list()); },
      start: (id: string) => {
        if (this.roomId && this.roomId !== id) return this.log("another room is already running the talk");
        if (this.roomId === id) return;
        this.roomId = id;
        this.log("host pressed Start: the talk plays in the room");
        this.markStarted(id);
      },
      closed: (id: string) => { if (this.roomId === id) { this.roomId = null; this.log("the room ended: sounds go nowhere until a new room starts"); } },
    };
  }

  /** Make files loadable by phones. New files are announced to every room straight away, before any cue needs them. */
  register(files: (string | undefined)[]) {
    let added = false;
    for (const f of files) {
      if (!f || this.registry.get(f)) continue;
      this.registry.learnLibrary(libraryFor(f));
      if (this.registry.add(f)) added = true;
    }
    if (added) for (const id of this.target ? [this.target] : this.manager.roomIds()) this.manager.setManifest(id, this.registry.list());
  }

  playOnce(file: string | undefined, gain: number, opts: { attackMs?: number; releaseMs?: number; maxS?: number } = {}): boolean {
    if (!file || !this.roomId) return false;
    this.register([file]);
    const asset = this.registry.get(file);
    if (!asset) return false;
    const r = this.manager.playCue(this.roomId, {
      assetId: asset.assetId, layerId: "sfx", gain,
      ...(opts.attackMs !== undefined ? { fadeInMs: opts.attackMs } : {}),
      ...(opts.releaseMs !== undefined ? { fadeOutMs: opts.releaseMs } : {}),
      ...(opts.maxS !== undefined ? { maxS: opts.maxS } : {}),
    });
    return "cue" in r;
  }

  setLoop(layer: Layer, file: string | undefined, level: number) {
    if (!this.roomId) return;
    if (!file) { this.beds[layer] = null; this.manager.stopCue(this.roomId, { layerId: layer }, 1500); return; }
    if (this.beds[layer]?.file === file) return this.setLevel(layer, level);
    this.register([file]);
    const asset = this.registry.get(file);
    if (!asset) return;
    this.beds[layer] = { file, level };
    this.manager.playCue(this.roomId, { assetId: asset.assetId, layerId: layer, gain: level, loop: true, fadeInMs: 4000, fadeOutMs: 4000 });
  }

  setLevel(layer: Layer, level: number) {
    const bed = this.beds[layer];
    if (!this.roomId || !bed || Math.abs(bed.level - level) < 0.03) return; // phones ramp smoothly; small steps aren't worth a message
    bed.level = level;
    this.manager.setLayerGain(this.roomId, layer, level, 2500);
  }

  level(layer: Layer) { return this.beds[layer]?.level; }

  duck(ms = 2500) { if (this.roomId) this.manager.duck(this.roomId, ms); }

  stopAll() {
    if (!this.roomId) return;
    for (const layer of ["music", "ambience"] as const) { this.beds[layer] = null; this.manager.stopCue(this.roomId, { layerId: layer }, 500); }
  }
}
