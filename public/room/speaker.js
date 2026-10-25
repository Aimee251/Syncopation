// @ts-check
// speaker.js — one phone's audio engine for a speaker room (spec §6, §7, §9, §10). Grown from mixer.html's graph,
// but nothing plays "now": every sound starts at the shared server time it was scheduled for.
//
//   source → envelope (fades) → layer gain (music / ambience level) → duck (beds only) → master → limiter → speaker
//   one-shots: source → envelope → effects bus → master …
//
// Mute safety: every source remembers the room generation it was scheduled under; a mute bumps the generation and
// stops them all, and anything arriving with an older generation is dropped.

import { scheduleCue, serverNow } from "/room/clock.js";

const SAFETY_MS = 30;        // a cue starting sooner than this is "late"
const MAX_VOICES = 24;       // simultaneous one-shots; the oldest is cut first

export class Speaker {
  constructor() {
    /** @type {AudioContext | null} */ this.ctx = null;
    /** @type {Map<string, AudioBuffer>} */ this.buffers = new Map();   // contentHash → decoded audio
    /** @type {Map<string, string>} */ this.hashOf = new Map();         // assetId → contentHash
    this.generation = 0;
    this.localMuted = false;
    this.volume = 0.8;
    this.deviceAdvanceMs = 0;
    this.lateCues = 0;
    /** @type {Set<{ src: AudioBufferSourceNode, env: GainNode, generation: number, cueId: string, layerId: string }>} */
    this.active = new Set();
    /** @type {Map<string, { gain: GainNode, current: any }>} */ this.layers = new Map();
    /** @type {() => number} */ this.offsetMs = () => 0;   // server − client, from the clock sync
  }

  /** Must run inside a tap: browsers only let audio start from a user gesture. */
  async enable() {
    if (!this.ctx) {
      const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
      const ctx = this.ctx = new AC({ latencyHint: "interactive" });
      this.limiter = ctx.createDynamicsCompressor();          // conservative safety net, not loudness
      this.limiter.threshold.value = -3; this.limiter.knee.value = 6; this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003; this.limiter.release.value = 0.25;
      this.master = ctx.createGain(); this.master.connect(this.limiter); this.limiter.connect(ctx.destination);
      this.duckGain = ctx.createGain(); this.duckGain.connect(this.master);
      this.sfxBus = ctx.createGain(); this.sfxBus.connect(this.master);
      this.applyMaster();
      // iOS: playing one silent sample inside the gesture unlocks output
      const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start();
    }
    if (this.ctx.state !== "running") await this.ctx.resume();
    return this.audioState;
  }

  get audioState() { return this.ctx ? (this.ctx.state === "running" ? "running" : this.ctx.state === "closed" ? "closed" : "suspended") : "suspended"; }

  // ---------------------------------------------------------------- assets
  /**
   * Fetch and decode every asset in the manifest that isn't decoded yet (cached by content hash).
   * @param {{ assets: { assetId: string, contentHash: string, url: string }[] }} manifest
   * @param {(done: number, total: number) => void} [onProgress]
   * @returns {Promise<{ loaded: string[], failed: string[] }>}
   */
  async load(manifest, onProgress) {
    const assets = manifest.assets;
    for (const a of assets) this.hashOf.set(a.assetId, a.contentHash);
    let done = 0;
    const failed = /** @type {string[]} */ ([]);
    const queue = [...assets];
    const worker = async () => {
      for (let a; (a = queue.shift());) {
        if (!this.buffers.has(a.contentHash)) {
          try {
            const res = await fetch(a.url);
            if (!res.ok) throw new Error(String(res.status));
            this.buffers.set(a.contentHash, await /** @type {AudioContext} */ (this.ctx).decodeAudioData(await res.arrayBuffer()));
          } catch { failed.push(a.assetId); }
        }
        onProgress?.(++done, assets.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return { loaded: assets.filter(a => this.buffers.has(a.contentHash)).map(a => a.assetId), failed };
  }

  // ---------------------------------------------------------------- timing
  /** Server ms → this phone's audio clock, sampled together so the two clocks line up. */
  now() {
    const ctx = /** @type {AudioContext} */ (this.ctx);
    return { audioNow: ctx.currentTime, serverNowMs: serverNow(performance.now(), this.offsetMs()) };
  }
  atAudio(/** @type {number} */ serverMs) {
    const { audioNow, serverNowMs } = this.now();
    return Math.max(audioNow, audioNow + (serverMs - serverNowMs) / 1000 - this.deviceAdvanceMs / 1000);
  }

  // ---------------------------------------------------------------- cues
  /**
   * @param {any} cue  a validated cue.play (or a loop from a snapshot / resume)
   * @returns {{ ok: true, joined: boolean } | { ok: false, reason: "late" | "missing_asset" | "not_ready" | "stale_generation" }}
   */
  play(cue) {
    if (!this.ctx || this.ctx.state !== "running") return { ok: false, reason: "not_ready" };
    if (cue.generation < this.generation) return { ok: false, reason: "stale_generation" };
    const buf = this.buffers.get(cue.contentHash);
    if (!buf) return { ok: false, reason: "missing_asset" };             // never a different sound instead
    const { audioNow, serverNowMs } = this.now();
    const d = scheduleCue({
      playAtServerMs: cue.playAtServerMs, serverNowMs, audioNow, deviceAdvanceMs: this.deviceAdvanceMs, safetyMarginMs: SAFETY_MS,
      loop: cue.loop, offsetSeconds: cue.offsetSeconds, durationS: buf.duration, anchorServerMs: cue.anchorServerMs,
      loopStartSeconds: cue.loopStartSeconds, loopEndSeconds: cue.loopEndSeconds,
    });
    if (d.action === "skip") { this.lateCues++; return { ok: false, reason: "late" }; }
    const ctx = this.ctx, t = d.when;
    const src = ctx.createBufferSource(); src.buffer = buf;               // a source plays once: always a fresh one
    const env = ctx.createGain();
    src.connect(env);
    const fadeIn = (d.joined ? Math.max(cue.fadeInMs, 600) : cue.fadeInMs) / 1000;   // joining a loop mid-way: fade in
    const entry = { src, env, generation: cue.generation, cueId: cue.cueId, layerId: cue.layerId };
    let stopAt = 0;   // one-shots only; stop() must come after start()

    if (cue.loop) {
      src.loop = true;
      if (cue.loopStartSeconds !== undefined) src.loopStart = cue.loopStartSeconds;
      if (cue.loopEndSeconds !== undefined) src.loopEnd = cue.loopEndSeconds;
      const layer = this.layer(cue.layerId);
      layer.gain.gain.cancelScheduledValues(t);
      layer.gain.gain.setTargetAtTime(cue.gain, t, 0.3);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + fadeIn);
      env.connect(layer.gain);
      if (layer.current) this.fadeOut(layer.current, t, cue.fadeOutMs / 1000);   // crossfade with the old bed
      layer.current = entry;
    } else {
      const length = Math.min(buf.duration - d.offset, cue.maxS ?? Infinity);
      const out = Math.min(cue.fadeOutMs / 1000, length * 0.3);
      env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(cue.gain, t + Math.min(fadeIn, length / 2));
      env.gain.setValueAtTime(cue.gain, t + length - out); env.gain.linearRampToValueAtTime(0, t + length);
      env.connect(/** @type {GainNode} */ (this.sfxBus));
      stopAt = t + length + 0.05;
      const oneShots = [...this.active].filter(a => !a.src.loop);
      if (oneShots.length >= MAX_VOICES) this.fadeOut(oneShots[0], ctx.currentTime, 0.05);
    }
    src.onended = () => { this.active.delete(entry); env.disconnect(); };
    this.active.add(entry);
    src.start(t, d.offset);
    if (stopAt) src.stop(stopAt);
    return { ok: true, joined: d.joined };
  }

  /** @param {{ layerId?: string, cueId?: string, stopAtServerMs: number, fadeOutMs: number, generation: number }} m */
  stop(m) {
    if (!this.ctx || m.generation < this.generation) return;
    const t = this.atAudio(m.stopAtServerMs);
    for (const a of this.active) if ((m.cueId && a.cueId === m.cueId) || (m.layerId && a.layerId === m.layerId)) this.fadeOut(a, t, m.fadeOutMs / 1000);
    const layer = m.layerId ? this.layers.get(m.layerId) : undefined;
    if (layer) layer.current = null;
  }

  /** @param {{ layerId: string, gain: number, atServerMs: number, rampMs: number, generation: number }} m */
  setLayerGain(m) {
    if (!this.ctx || m.generation < this.generation) return;
    const t = this.atAudio(m.atServerMs), g = this.layer(m.layerId).gain.gain;
    g.cancelScheduledValues(t); g.setTargetAtTime(m.gain, t, Math.max(0.05, m.rampMs / 3000));
  }

  /** @param {{ atServerMs: number, depth: number, holdMs: number, generation: number }} m */
  duck(m) {
    if (!this.ctx || m.generation < this.generation) return;
    const t = this.atAudio(m.atServerMs), g = /** @type {GainNode} */ (this.duckGain).gain;
    g.cancelScheduledValues(t); g.setTargetAtTime(m.depth, t, 0.08); g.setTargetAtTime(1, t + m.holdMs / 1000, 0.45);
  }

  /** Mute all / room closed / connection lost: everything fades out now, and nothing scheduled earlier may sound. */
  silence(generation = this.generation, fadeS = 0.08) {
    this.generation = Math.max(this.generation, generation);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const a of [...this.active]) this.fadeOut(a, t, fadeS);
    for (const l of this.layers.values()) l.current = null;
  }

  /**
   * Replace local playback with the room's state (spec §8: a snapshot is a replacement, not a patch).
   * @returns {{ cueId: string, reason: string }[]} cues that couldn't play
   */
  applySnapshot(/** @type {any} */ snap) {
    this.silence(snap.generation, 0.3);
    this.generation = snap.generation;
    if (snap.muted) return [];
    const skipped = [];
    for (const c of [...snap.loops, ...snap.pendingCues]) {
      const r = this.play({ ...c, generation: snap.generation });
      if (!r.ok) skipped.push({ cueId: c.cueId, reason: r.reason });
    }
    return skipped;
  }

  setLocalMute(/** @type {boolean} */ on) { this.localMuted = on; this.applyMaster(); }
  setVolume(/** @type {number} */ v) { this.volume = Math.max(0, Math.min(1, v)); this.applyMaster(); }
  applyMaster() {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.localMuted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  // ----------------------------------------------------------------
  /** @param {string} id */
  layer(id) {
    let l = this.layers.get(id);
    if (!l) {
      const ctx = /** @type {AudioContext} */ (this.ctx), gain = ctx.createGain();
      gain.connect(/** @type {GainNode} */ (this.duckGain));        // beds dip while the presenter speaks
      this.layers.set(id, l = { gain, current: null });
    }
    return l;
  }
  /** @param {{ src: AudioBufferSourceNode, env: GainNode }} a */
  fadeOut(a, t, s) {
    const g = a.env.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + Math.max(0.01, s));
    try { a.src.stop(t + Math.max(0.01, s) + 0.05); } catch { /* already stopped */ }
  }
}
