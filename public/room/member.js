// @ts-check
// member.js — one phone acting as a speaker: joins with a code, enables audio, loads the sounds, keeps its clock in
// sync, plays the room's cues and reports honestly whether it is Ready (spec §3 Participant, §6, §9).
// Used by the join page and by the host page's "play on this phone too".

import { RoomConnection } from "/room/connection.js";
import { Speaker } from "/room/speaker.js";

const GRACE_MS = 2000; // connection lost: keep playing this long before fading out

/** What the phone shows; mirrors the server's states plus room-level conditions. */
/** @typedef {"joining" | "enabling_sound" | "loading" | "synchronizing" | "ready" | "muted" | "reconnecting" | "ended"} Status */

export class MemberSession {
  /** @param {(s: MemberSession) => void} onUpdate */
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.conn = new RoomConnection({ role: "member" });
    this.speaker = new Speaker();
    this.speaker.offsetMs = () => this.conn.offsetMs();
    /** @type {any} */ this.manifest = null;
    /** @type {string[]} */ this.loaded = [];
    /** @type {string[]} */ this.failed = [];
    this.progress = { done: 0, total: 0 };
    this.snapshotApplied = false;
    this.roomMuted = false;
    this.connected = false;
    this.joined = false;
    /** @type {string} */ this.endedReason = "";
    /** @type {{ code: string, message: string } | null} */ this.error = null;
    this.displayName = "";
    this.loading = false;
    this.wasFresh = false;
    /** @type {number | undefined} */ this.graceTimer = undefined;
    this.conn.statusReport = () => ({ audioState: this.speaker.audioState, lateCues: this.speaker.lateCues, ...(this.degraded() ? { state: "degraded" } : {}) });
    this.wire();
    document.addEventListener("visibilitychange", () => this.onVisibility());
  }

  /** @returns {Status} */
  get status() {
    if (this.endedReason) return "ended";
    if (!this.joined) return "joining";
    if (!this.connected) return "reconnecting";
    if (this.speaker.audioState !== "running") return "enabling_sound";
    if (this.loading || !this.manifest || this.manifest.assets.some((/** @type {any} */ a) => !this.loaded.includes(a.assetId) && !this.failed.includes(a.assetId))) return "loading";
    if (!this.snapshotApplied || !this.conn.clockFresh()) return "synchronizing";
    if (this.roomMuted) return "muted";
    return "ready";
  }
  degraded() { return !!this.conn.clock && this.conn.clock.uncertaintyMs > 100; }

  /** Join with a six-digit code (or resume this tab's earlier membership if it has a token). */
  join(/** @type {string} */ code, displayName = "") {
    this.error = null; this.displayName = displayName;
    this.conn.onOpenFresh = () => this.conn.send("room.join", { code, ...(displayName ? { displayName } : {}) });
    this.conn.connect();
  }
  /** Resume after a page reload, if this tab was in a room. */
  resume() { if (!this.conn.token) return false; this.conn.connect(); return true; }

  /** Call from a tap. */
  async enable() {
    const ctx = this.speaker.enable();     // starts inside the gesture
    await ctx;
    this.speaker.ctx?.addEventListener("statechange", () => { this.report(); this.update(); });
    await this.loadManifest();
    this.update();
  }

  setLocalMute(/** @type {boolean} */ on) { this.speaker.setLocalMute(on); this.update(); }
  setVolume(/** @type {number} */ v) { this.speaker.setVolume(v); }
  leave() { this.speaker.silence(); this.conn.leave(); this.endedReason = "left"; this.update(); }

  // ----------------------------------------------------------------
  wire() {
    const c = this.conn;
    c.on("connected", () => { clearTimeout(this.graceTimer); this.connected = true; this.update(); });
    c.on("disconnected", () => {
      this.connected = false; this.snapshotApplied = false;
      // a short blip shouldn't cut the music; a longer loss must not leave stale sound running
      this.graceTimer = window.setTimeout(() => this.speaker.silence(this.speaker.generation, 0.5), GRACE_MS);
      this.update();
    });
    c.on("room.joined", () => { this.joined = true; this.wasFresh = false; this.update(); if (this.speaker.audioState === "running") this.loadManifest(); });
    c.on("assets.manifest", m => { this.manifest = m; this.update(); if (this.speaker.audioState === "running") this.loadManifest(); });
    c.on("room.snapshot", s => {
      this.roomMuted = s.muted;
      if (this.speaker.audioState !== "running" || this.loading) { this.snapshotApplied = false; return this.update(); }
      clearTimeout(this.graceTimer);
      for (const skip of this.speaker.applySnapshot(s)) c.send("member.status", { skipped: { cueId: skip.cueId, reason: skip.reason } });
      this.snapshotApplied = true;
      this.report(); this.update();
    });
    c.on("cue.play", m => {
      if (this.roomMuted) return;
      const r = this.speaker.play(m);
      if (!r.ok) c.send("member.status", { skipped: { cueId: m.cueId, reason: r.reason }, lateCues: this.speaker.lateCues });
    });
    c.on("cue.stop", m => this.speaker.stop(m));
    c.on("layer.gain", m => this.speaker.setLayerGain(m));
    c.on("layer.duck", m => this.speaker.duck(m));
    c.on("room.mute", m => { this.roomMuted = true; this.speaker.silence(m.generation); this.update(); });
    c.on("room.resume", m => {
      // fresh scheduling for the loops at their current phase; one-shots missed while muted are gone (local mute stays as it is)
      this.roomMuted = false; this.speaker.generation = m.generation;
      for (const loop of m.loops) this.speaker.play({ ...loop, generation: m.generation, playAtServerMs: m.resumeAtServerMs });
      this.update();
    });
    c.on("room.closed", m => { this.speaker.silence(); this.endedReason = m.reason; this.update(); });
    c.on("expired", () => { this.speaker.silence(); this.endedReason = "expired"; this.update(); });
    c.on("error", m => { this.error = m; this.update(); });
    c.on("clock", () => {
      const fresh = this.conn.clockFresh();
      if (fresh && !this.wasFresh) this.report();               // first usable clock: tell the server straight away
      this.wasFresh = fresh;
      this.update();
    });
  }

  async loadManifest() {
    const m = this.manifest;
    if (!m || this.loading) return;
    this.loading = true; this.update();
    const r = await this.speaker.load(m, (done, total) => { this.progress = { done, total }; this.update(); });
    this.loaded = r.loaded; this.failed = r.failed;
    this.loading = false;
    if (this.manifest !== m) return this.loadManifest();         // a newer list arrived while loading
    this.report();
    this.conn.send("snapshot.request");                          // now that the sounds are here, take the room's current state
    this.update();
  }

  report() {
    if (!this.joined || !this.manifest) return;
    this.conn.send("member.ready", {
      manifestVersion: this.manifest.version, loadedAssetIds: this.loaded, audioState: this.speaker.audioState,
      snapshotApplied: this.snapshotApplied, ...(this.conn.clockDiag() ? { clock: this.conn.clockDiag() } : {}),
    });
  }

  onVisibility() {
    if (!this.joined || this.endedReason) return;
    if (document.hidden) {
      // backgrounded: stop rather than drift; we'll take a fresh snapshot on return
      this.speaker.silence(this.speaker.generation, 0.2);
      this.snapshotApplied = false;
      this.report(); this.update();
      return;
    }
    this.speaker.ctx?.resume().catch(() => { }).finally(() => {
      this.conn.syncBurst(5);
      this.conn.send("snapshot.request");
      this.report(); this.update();
    });
  }

  update() { this.onUpdate(this); }
}
