// @ts-check
// connection.js — a phone's link to the room service (spec §5, §7, §8, §9): the socket, credentials, clock sync,
// event ordering and reconnects. It decides nothing about sound; pages listen with on(type, fn).
//
// Ordering: room events are numbered. After a snapshot, each event must be the next number. A gap means something
// was missed, so the phone asks for a fresh snapshot and holds later events until it arrives (spec §8).
// Tokens live in sessionStorage (this tab only) and are sent in a message, never in the URL.

import { PROTOCOL_VERSION, parseServerMessage } from "/room/protocol.js";
import { estimateOffset, isFresh } from "/room/clock.js";

const ROOM_EVENTS = new Set(["cue.play", "cue.stop", "layer.gain", "layer.duck", "room.mute", "room.resume"]);

export class RoomConnection {
  /** @param {{ role: "host" | "member" }} opts */
  constructor({ role }) {
    this.role = role;
    this.storageKey = `syncopation.room.${role}`;
    /** @type {WebSocket | null} */ this.ws = null;
    /** @type {Record<string, ((m: any) => void)[]>} */ this.listeners = {};
    this.epoch = "";
    this.roomId = "";
    /** @type {number | null} */ this.seq = null;   // last applied event; null until the first snapshot
    this.reconciling = false;
    /** @type {any[]} */ this.held = [];
    /** @type {Set<string>} */ this.seenCues = new Set();
    /** @type {{ c0: number, s1: number, s2: number, c3: number }[]} */ this.samples = [];
    /** @type {import("/room/clock.js").ClockEstimate | null} */ this.clock = null;
    this.requestId = 0;
    this.attempt = 0;
    this.authPending = false;  // sent room.auth, no answer yet
    this.finished = false;     // room closed or left: no reconnecting
    this.timers = /** @type {number[]} */ ([]);
    /** @type {() => object} */ this.statusReport = () => ({});
    /** @type {(() => void) | null} */ this.onOpenFresh = null; // called when there's no token to resume with
  }

  get token() { try { return sessionStorage.getItem(this.storageKey); } catch { return null; } }
  set token(v) { try { v ? sessionStorage.setItem(this.storageKey, v) : sessionStorage.removeItem(this.storageKey); } catch { /* private mode: no resume */ } }

  /** @param {string} type @param {(m: any) => void} fn */
  on(type, fn) { (this.listeners[type] ??= []).push(fn); return this; }
  emit(/** @type {string} */ type, /** @type {any} */ m) { for (const fn of this.listeners[type] ?? []) fn(m); }

  send(/** @type {string} */ type, body = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type, ...body }));
  }

  connect() {
    this.finished = false;
    const ws = this.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/room`);
    ws.onopen = () => {
      this.attempt = 0;
      this.emit("connected", {});
      const token = this.token;
      this.authPending = !!token;
      if (token) this.send("room.auth", { token });
      else this.onOpenFresh?.();
    };
    ws.onmessage = e => this.receive(String(e.data));
    ws.onclose = () => {
      this.stopTimers();
      this.seq = null; this.held = []; this.reconciling = false;
      if (this.finished) return;
      this.emit("disconnected", {});
      const delay = Math.min(8000, 500 * 2 ** this.attempt++);     // bounded exponential backoff
      setTimeout(() => { if (!this.finished) this.connect(); }, delay);
    };
  }

  /** Leave on purpose: tell the server, forget the token, don't reconnect. */
  leave() {
    if (this.role === "member") this.send("member.leave");
    this.finish();
  }
  finish() { this.finished = true; this.token = null; this.stopTimers(); this.ws?.close(); }

  // ---------------------------------------------------------------- incoming
  receive(/** @type {string} */ text) {
    const c3 = performance.now();
    const p = parseServerMessage(text);
    if (!p.ok) return console.warn("room: ignored message:", p.error);
    const m = p.msg;
    switch (m.type) {
      case "sync.response": {
        if (this.epoch && m.serverEpochId !== this.epoch) return; // server restarted: the room is gone anyway
        this.samples = [...this.samples.slice(-19), { c0: m.c0, s1: m.s1, s2: m.s2, c3 }];
        this.clock = estimateOffset(this.samples, c3);
        return this.emit("clock", this.clock);
      }
      case "room.created":
        this.token = m.hostToken;
        this.adopt(m);
        return this.emit(m.type, m);
      case "room.joined":
        if (m.token) this.token = m.token;
        this.adopt(m);
        if (this.role === "member") this.startTimers(m.heartbeatMs ?? 5000);
        return this.emit(m.type, m);
      case "room.snapshot": {
        if (m.serverEpochId !== this.epoch) return;
        this.seq = m.sequence; this.reconciling = false;
        this.emit("room.snapshot", m);
        const later = this.held.filter(e => e.sequence > m.sequence).sort((a, b) => a.sequence - b.sequence);
        this.held = [];
        for (const e of later) this.event(e);
        return;
      }
      case "room.closed":
        this.finish();
        return this.emit(m.type, m);
      case "error":
        if (m.code === "unauthorized" && this.authPending) { this.authPending = false; this.finish(); return this.emit("expired", m); } // room gone while away
        return this.emit("error", m);
    }
    if (ROOM_EVENTS.has(m.type)) return this.event(m);
    this.emit(m.type, m);   // assets.manifest, room.members
  }

  adopt(/** @type {any} */ m) {
    this.authPending = false;
    this.epoch = m.serverEpochId; this.roomId = m.roomId;
    this.samples = []; this.clock = null;
    this.syncBurst(10);
  }

  /** In-order delivery of numbered room events. */
  event(/** @type {any} */ m) {
    if (m.serverEpochId !== this.epoch || m.roomId !== this.roomId) return;
    if (this.seq === null || this.reconciling) return void this.held.push(m);
    if (m.sequence <= this.seq) return;                          // already applied
    if (m.sequence !== this.seq + 1) {                           // gap: don't guess what was missed
      this.reconciling = true; this.held.push(m);
      return this.send("snapshot.request");
    }
    this.seq = m.sequence;
    if (m.type === "cue.play") {
      if (this.seenCues.has(m.cueId)) return;
      this.seenCues.add(m.cueId);
      if (this.seenCues.size > 500) this.seenCues.delete(/** @type {string} */ (this.seenCues.values().next().value));
    }
    this.emit(m.type, m);
  }

  // ---------------------------------------------------------------- clock + heartbeat
  syncBurst(n = 3, spacingMs = 60) {
    for (let i = 0; i < n; i++) setTimeout(() => this.send("sync.request", { requestId: ++this.requestId, c0: performance.now() }), i * spacingMs);
  }
  clockFresh() { return isFresh(this.clock, performance.now()); }
  clockDiag() {
    const c = this.clock;
    return c ? { offsetMs: c.offsetMs, uncertaintyMs: c.uncertaintyMs, rttMs: c.rttMs, ageMs: Math.max(0, performance.now() - c.measuredAtMs) } : undefined;
  }
  offsetMs() { return this.clock?.offsetMs ?? 0; }

  startTimers(/** @type {number} */ heartbeatMs) {
    this.stopTimers();
    this.timers.push(window.setInterval(() => this.syncBurst(3), 5000));
    this.timers.push(window.setInterval(() => this.send("member.status", { ...this.statusReport(), clock: this.clockDiag() }), heartbeatMs));
  }
  stopTimers() { this.timers.forEach(t => clearInterval(t)); this.timers = []; }
}
