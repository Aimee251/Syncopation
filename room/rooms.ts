// room/rooms.ts — the authoritative speaker-room state (spec §5, §6, §8, §9). No sockets here: server.ts hands it
// connections and raw messages, and tests drive it with fake connections and a fake clock.
//
// Rooms live in memory in this one process. A restart changes serverEpochId and loses every room; phones then see
// their room as gone and must join again. Do not run several of these behind a load balancer without shared state.
//
// Who may do what:
//   host    (holds the host token from room.create)   start the talk / mute / resume / lock / remove / end / test sound
//   member  (holds a member token from room.join)       report its own readiness, status, leave, ask for a snapshot
//   in-process callers (the cue adapter in predict.ts) play / stop cues, change layer gain, duck, publish the manifest
// Members can never make the room play, mute or close.
// Anyone can create a room (the host is usually a phone, and there are no accounts yet): creation is rate-limited,
// and the host token, not the code, is what controls a room.

import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PROTOCOL_VERSION, parseClientMessage } from "./protocol.js";

export type MemberState = "enabling_sound" | "loading" | "synchronizing" | "ready" | "degraded" | "disconnected";
export type CloseReason = "ended" | "removed" | "expired" | "idle" | "host_timeout" | "server_restart";

export const DEFAULT_CONFIG = {
  maxParticipants: 10,
  lifetimeMs: 4 * 60 * 60_000,
  idleMs: 30 * 60_000,
  heartbeatMs: 5_000,
  staleMs: 15_000,          // no message for this long → the connection is treated as gone
  hostGraceMs: 60_000,      // host may reconnect within this; then the room closes
  memberRejoinMs: 60_000,   // a disconnected phone keeps its slot (and token) this long
  leadMs: 400,              // cues are scheduled this far ahead of the decision
  maxClockUncertaintyMs: 100,
  maxClockAgeMs: 15_000,
  cueCacheSize: 2_000,      // cueIds remembered for de-duplication
  createPerMinute: 5,
  badJoinsPerMinute: 10,
  syncPerSecond: 20,
  allowRemoteCreate: true,  // false = only the machine running the server (loopback) can create rooms
};
export type RoomConfig = typeof DEFAULT_CONFIG;

/** In-process listeners: how the sound engine learns a room exists, the host pressed Start, or the room is gone. */
export type RoomHooks = {
  created?(roomId: string): void; start?(roomId: string): void; closed?(roomId: string): void;
  /** the host (re)connected: send it whatever it needs to redraw */
  hostConnected?(roomId: string): void;
  /** host messages the room service doesn't handle itself (the talk: host.setup, host.say …), already checked as host-only */
  host?(roomId: string, msg: Record<string, any> & { type: string }): void;
};

/** One socket, as the room service sees it. */
export interface Conn {
  id: string;
  ip: string;
  loopback: boolean;
  send(msg: object): void;
  close(code?: number, reason?: string): void;
}

export type Asset = {
  assetId: string; contentHash: string; url: string; mimeType: string; durationS: number;
  loopStartSeconds?: number; loopEndSeconds?: number;
};
export type Manifest = { version: number; assets: Asset[] };

export type CueInput = {
  assetId: string; layerId: string; loop?: boolean; gain: number;
  offsetSeconds?: number; fadeInMs?: number; fadeOutMs?: number; maxS?: number; cueId?: string;
};
/** A cue as it goes on the wire, minus the room envelope. */
export type Cue = {
  cueId: string; assetId: string; contentHash: string; layerId: string; playAtServerMs: number; offsetSeconds: number;
  loop: boolean; gain: number; fadeInMs: number; fadeOutMs: number; latePolicy: "skip" | "join"; durationS: number;
  maxS?: number; loopStartSeconds?: number; loopEndSeconds?: number; anchorServerMs?: number;
};

type ReadyReport = {
  manifestVersion: number; loadedAssetIds: string[]; audioState: string; snapshotApplied: boolean;
  clock?: { offsetMs: number; uncertaintyMs: number; rttMs: number; ageMs: number }; reportedAt: number;
};
type Member = {
  id: string; tokenHash: string; displayName: string; conn: Conn | null; state: MemberState; joinedAt: number;
  lastSeen: number; disconnectedAt: number | null; snapshotSent: boolean; report: ReadyReport | null;
  degraded: boolean; lateCues: number; lastSkip?: { cueId: string; reason: string };
};
type Room = {
  id: string; code: string; name: string; pack: string; createdAt: number; lastActivity: number;
  locked: boolean; muted: boolean; muteReason: string; generation: number; sequence: number;
  hostTokenHash: string; hostConn: Conn | null; hostLostAt: number | null;
  members: Map<string, Member>; manifest: Manifest; loops: Map<string, Cue>; pending: Cue[]; recentCueIds: Set<string>;
};
type Binding = { conn: Conn; roomId?: string; role?: "host" | "member"; memberId?: string; syncWindow: { start: number; count: number } };

type Rng = { code(): string; token(): string; id(): string };
const cryptoRng: Rng = {
  code: () => String(randomInt(0, 1_000_000)).padStart(6, "0"),
  token: () => randomBytes(32).toString("base64url"),
  id: () => randomUUID(),
};
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Fixed-window counter per key: hit() returns false once the limit for this window is used up. */
class Limiter {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(private limit: () => number, private windowMs: number, private now: () => number) { }
  over(key: string) { const h = this.hits.get(key); return !!h && this.now() - h.start < this.windowMs && h.n >= this.limit(); }
  hit(key: string) {
    const t = this.now(), h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) this.hits.set(key, { start: t, n: 1 });
    else h.n++;
  }
  prune() { const t = this.now(); for (const [k, h] of this.hits) if (t - h.start >= this.windowMs) this.hits.delete(k); }
}

export class RoomManager {
  readonly config: RoomConfig;
  readonly serverEpochId: string;
  private rooms = new Map<string, Room>();
  private codes = new Map<string, string>();                                  // code → roomId
  private tokens = new Map<string, { roomId: string; memberId?: string }>();  // token hash → who (no memberId = host)
  private bindings = new Map<string, Binding>();                              // conn.id → binding
  private creates: Limiter;
  private badJoins: Limiter;

  hooks: RoomHooks;

  constructor(opts: { config?: Partial<RoomConfig>; now?: () => number; rng?: Partial<Rng>; hooks?: RoomHooks } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.hooks = opts.hooks ?? {};
    this.now = opts.now ?? (() => performance.now());
    this.rng = { ...cryptoRng, ...opts.rng };
    this.serverEpochId = this.rng.id();
    this.creates = new Limiter(() => this.config.createPerMinute, 60_000, this.now);
    this.badJoins = new Limiter(() => this.config.badJoinsPerMinute, 60_000, this.now);
  }
  /** Server monotonic clock, ms. */
  readonly now: () => number;
  private rng: Rng;

  // =====================================================================
  // Connections
  // =====================================================================
  connect(conn: Conn) { this.bindings.set(conn.id, { conn, syncWindow: { start: 0, count: 0 } }); }

  disconnect(conn: Conn) {
    const b = this.bindings.get(conn.id);
    this.bindings.delete(conn.id);
    const room = b?.roomId ? this.rooms.get(b.roomId) : undefined;
    if (!b || !room) return;
    if (b.role === "host" && room.hostConn?.id === conn.id) {
      // host lost: stop the sound everywhere and wait for the host to come back and resume explicitly
      room.hostConn = null;
      room.hostLostAt = this.now();
      if (!room.muted) this.mute(room.id, "host_disconnected");
    } else if (b.role === "member" && b.memberId) {
      const m = room.members.get(b.memberId);
      if (m && m.conn?.id === conn.id) {
        m.conn = null; m.disconnectedAt = this.now(); m.snapshotSent = false; m.report = null;
        this.refresh(room, m);
      }
    }
  }

  receive(conn: Conn, raw: string | Buffer) {
    const s1 = this.now(); // receive time, before any work, for sync.response
    const b = this.bindings.get(conn.id);
    if (!b) return;
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return this.error(conn, "bad_message", parsed.error);
    const msg = parsed.msg;
    const room = b.roomId ? this.rooms.get(b.roomId) : undefined;
    if (room) {
      if (b.role === "member" && b.memberId) { const m = room.members.get(b.memberId); if (m) m.lastSeen = s1; }
      if (b.role === "host") room.lastActivity = s1;
    }
    switch (msg.type) {
      case "room.create": return this.onCreate(b, msg);
      case "room.join": return this.onJoin(b, msg);
      case "room.auth": return this.onAuth(b, msg);
      case "sync.request": {
        if (!room) return this.error(conn, "unauthorized", "join a room first");
        const w = b.syncWindow;
        if (s1 - w.start >= 1000) { w.start = s1; w.count = 0; }
        if (++w.count > this.config.syncPerSecond) return this.error(conn, "rate_limited", "too many sync requests");
        return conn.send({ protocolVersion: PROTOCOL_VERSION, type: "sync.response", requestId: msg.requestId, c0: msg.c0, s1, s2: this.now(), serverEpochId: this.serverEpochId });
      }
      case "snapshot.request":
        if (!room) return this.error(conn, "unauthorized", "join a room first");
        return this.sendSnapshot(room, conn, b.memberId);
    }
    if (msg.type.startsWith("member.")) {
      const m = room && b.role === "member" && b.memberId ? room.members.get(b.memberId) : undefined;
      if (!room || !m) return this.error(conn, "unauthorized", "members only");
      if (msg.type === "member.leave") return this.removeMember(room.id, m.id, null);
      if (msg.type === "member.ready") {
        m.report = { manifestVersion: msg.manifestVersion, loadedAssetIds: msg.loadedAssetIds, audioState: msg.audioState, snapshotApplied: msg.snapshotApplied, clock: msg.clock, reportedAt: s1 };
        m.degraded = false;
      } else { // member.status: heartbeat + diagnostics
        if (m.report && msg.audioState) m.report.audioState = msg.audioState;
        if (m.report && msg.clock) { m.report.clock = msg.clock; m.report.reportedAt = s1; }
        if (typeof msg.lateCues === "number") m.lateCues = msg.lateCues;
        if (msg.skipped) m.lastSkip = msg.skipped;
        if (msg.state === "degraded") m.degraded = true;
      }
      return this.refresh(room, m);
    }
    if (msg.type.startsWith("host.")) {
      if (!room || b.role !== "host" || room.hostConn?.id !== conn.id) return this.error(conn, "unauthorized", "host only");
      switch (msg.type) {
        case "host.mute": return void this.mute(room.id, msg.reason ?? "host");
        case "host.resume": return void this.resume(room.id);
        case "host.lock": return void this.lock(room.id, msg.locked);
        case "host.remove": return void (this.removeMember(room.id, msg.memberId, "removed") || this.error(conn, "not_found", "no such member"));
        case "host.end": return void this.endRoom(room.id, "ended");
        case "host.start": return void this.hooks.start?.(room.id);
        case "host.setup": case "host.useSession": case "host.say": case "host.command":
          room.lastActivity = this.now();
          return void this.hooks.host?.(room.id, msg);
        case "host.test": {
          // default test sound: the shortest asset (an effect, not a three-minute music bed)
          const assetId = msg.assetId ?? [...room.manifest.assets].sort((a, b) => a.durationS - b.durationS)[0]?.assetId;
          const r = assetId ? this.playCue(room.id, { assetId, layerId: "test", gain: 0.8 }) : { error: "unknown_asset" as const };
          if ("error" in r) return this.error(conn, r.error, "no playable test asset");
          return;
        }
      }
    }
  }

  // =====================================================================
  // Room lifecycle
  // =====================================================================
  private onCreate(b: Binding, msg: any) {
    const { conn } = b;
    if (b.roomId) return this.error(conn, "bad_message", "this connection is already in a room");
    if (!conn.loopback && !this.config.allowRemoteCreate) return this.error(conn, "create_forbidden", "rooms can only be created from the presenter's machine");
    if (this.creates.over(conn.ip)) return this.error(conn, "rate_limited", "too many rooms created");
    this.creates.hit(conn.ip);
    let code = this.rng.code();
    for (let i = 0; this.codes.has(code); i++) { // single-threaded: check-and-insert below can't race
      if (i > 50) return this.error(conn, "rate_limited", "no free room code");
      code = this.rng.code();
    }
    const token = this.rng.token(), t = this.now();
    const room: Room = {
      id: this.rng.id(), code, name: msg.name ?? "", pack: msg.pack ?? "", createdAt: t, lastActivity: t,
      locked: false, muted: false, muteReason: "", generation: 1, sequence: 0,
      hostTokenHash: hash(token), hostConn: conn, hostLostAt: null,
      members: new Map(), manifest: { version: 0, assets: [] }, loops: new Map(), pending: [], recentCueIds: new Set(),
    };
    this.rooms.set(room.id, room);
    this.codes.set(code, room.id);
    this.tokens.set(room.hostTokenHash, { roomId: room.id });
    Object.assign(b, { roomId: room.id, role: "host" });
    conn.send({
      protocolVersion: PROTOCOL_VERSION, type: "room.created", roomId: room.id, code, hostToken: token, serverEpochId: this.serverEpochId,
      expiresAtServerMs: t + this.config.lifetimeMs, serverNowMs: t, maxParticipants: this.config.maxParticipants,
    });
    this.pushMembers(room);
    this.hooks.created?.(room.id);
  }

  private onJoin(b: Binding, msg: any) {
    const { conn } = b;
    if (b.roomId) return this.error(conn, "bad_message", "this connection is already in a room");
    const keys = [`ip:${conn.ip}`, `conn:${conn.id}`];
    if (keys.some(k => this.badJoins.over(k))) return this.error(conn, "rate_limited", "too many wrong codes, wait a minute");
    const room = this.rooms.get(this.codes.get(msg.code) ?? "");
    if (!room) { keys.forEach(k => this.badJoins.hit(k)); return this.error(conn, "invalid_code", "no active room with that code"); }
    if (room.locked) return this.error(conn, "room_locked", "the presenter has locked this room");
    if (room.members.size >= this.config.maxParticipants) return this.error(conn, "room_full", "this room is full");
    const token = this.rng.token(), t = this.now();
    const m: Member = {
      id: this.rng.id(), tokenHash: hash(token), displayName: (msg.displayName ?? "").trim() || `Phone ${room.members.size + 1}`,
      conn, state: "enabling_sound", joinedAt: t, lastSeen: t, disconnectedAt: null, snapshotSent: false, report: null, degraded: false, lateCues: 0,
    };
    room.members.set(m.id, m);
    this.tokens.set(m.tokenHash, { roomId: room.id, memberId: m.id });
    Object.assign(b, { roomId: room.id, role: "member", memberId: m.id });
    room.lastActivity = t;
    this.welcomeMember(room, m, token);
    this.pushMembers(room);
  }

  /** Reconnect with a token from room.created / room.joined. The token travels in a message, never in a URL. */
  private onAuth(b: Binding, msg: any) {
    const { conn } = b;
    if (b.roomId) return this.error(conn, "bad_message", "this connection is already in a room");
    const who = this.tokens.get(hash(msg.token));
    const room = who ? this.rooms.get(who.roomId) : undefined;
    if (!who || !room) return this.error(conn, "unauthorized", "room ended or token expired");
    if (!who.memberId) {
      if (room.hostConn && room.hostConn.id !== conn.id) { this.bindings.delete(room.hostConn.id); room.hostConn.close(4001, "host connected elsewhere"); }
      room.hostConn = conn; room.hostLostAt = null; room.lastActivity = this.now();
      Object.assign(b, { roomId: room.id, role: "host" });
      // still muted if it was muted when the host dropped: the host has to press Resume
      conn.send({ protocolVersion: PROTOCOL_VERSION, type: "room.joined", role: "host", roomId: room.id, code: room.code, serverEpochId: this.serverEpochId, muted: room.muted, locked: room.locked });
      this.sendSnapshot(room, conn);
      this.pushMembers(room);
      return this.hooks.hostConnected?.(room.id);
    }
    const m = room.members.get(who.memberId);
    if (!m) return this.error(conn, "unauthorized", "removed from the room");
    if (m.conn && m.conn.id !== conn.id) { this.bindings.delete(m.conn.id); m.conn.close(4001, "connected elsewhere"); }
    Object.assign(m, { conn, lastSeen: this.now(), disconnectedAt: null, report: null, degraded: false });
    Object.assign(b, { roomId: room.id, role: "member", memberId: m.id });
    this.welcomeMember(room, m);
  }

  private welcomeMember(room: Room, m: Member, token?: string) {
    m.conn!.send({
      protocolVersion: PROTOCOL_VERSION, type: "room.joined", role: "member", roomId: room.id, memberId: m.id, displayName: m.displayName,
      ...(token ? { token } : {}), serverEpochId: this.serverEpochId, heartbeatMs: this.config.heartbeatMs, leadMs: this.config.leadMs,
    });
    m.conn!.send({ protocolVersion: PROTOCOL_VERSION, type: "assets.manifest", roomId: room.id, ...room.manifest });
    this.sendSnapshot(room, m.conn!, m.id);
  }

  /** Authoritative state: a phone replaces what it has with this, it doesn't patch. Next event has sequence + 1. */
  private sendSnapshot(room: Room, conn: Conn, memberId?: string) {
    const t = this.now();
    room.pending = room.pending.filter(c => c.playAtServerMs > t);
    conn.send({
      protocolVersion: PROTOCOL_VERSION, type: "room.snapshot", roomId: room.id, serverEpochId: this.serverEpochId,
      generation: room.generation, sequence: room.sequence, serverNowMs: t, muted: room.muted, muteReason: room.muteReason, locked: room.locked,
      manifestVersion: room.manifest.version, loops: [...room.loops.values()], pendingCues: room.muted ? [] : room.pending,
    });
    const m = memberId ? room.members.get(memberId) : undefined;
    if (m) { m.snapshotSent = true; this.refresh(room, m); }
  }

  lock(roomId: string, locked: boolean) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.locked = locked;
    this.pushMembers(room);
    return true;
  }

  /** null reason = the member left by itself. */
  removeMember(roomId: string, memberId: string, reason: CloseReason | null) {
    const room = this.rooms.get(roomId);
    const m = room?.members.get(memberId);
    if (!room || !m) return false;
    room.members.delete(m.id);
    this.tokens.delete(m.tokenHash);
    if (m.conn) {
      this.bindings.delete(m.conn.id);
      if (reason) m.conn.send({ protocolVersion: PROTOCOL_VERSION, type: "room.closed", reason });
      m.conn.close(4000, reason ?? "left");
    }
    this.pushMembers(room);
    return true;
  }

  /** End: code and every token stop working at once, pending cues are cancelled, phones stop and disconnect. */
  endRoom(roomId: string, reason: CloseReason) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    this.rooms.delete(room.id);
    this.codes.delete(room.code);
    this.tokens.delete(room.hostTokenHash);
    const conns = [room.hostConn, ...[...room.members.values()].map(m => { this.tokens.delete(m.tokenHash); return m.conn; })];
    for (const c of conns) {
      if (!c) continue;
      this.bindings.delete(c.id);
      c.send({ protocolVersion: PROTOCOL_VERSION, type: "room.closed", reason });
      c.close(4000, reason);
    }
    this.hooks.closed?.(room.id);
    return true;
  }

  /** Expiry, idle, host grace, stale sockets. server.ts calls this about once a second. */
  tick() {
    const t = this.now(), c = this.config;
    this.creates.prune(); this.badJoins.prune();
    for (const room of [...this.rooms.values()]) {
      if (t - room.createdAt > c.lifetimeMs) { this.endRoom(room.id, "expired"); continue; }
      if (t - room.lastActivity > c.idleMs) { this.endRoom(room.id, "idle"); continue; }
      if (room.hostLostAt !== null && t - room.hostLostAt > c.hostGraceMs) { this.endRoom(room.id, "host_timeout"); continue; }
      for (const m of [...room.members.values()]) {
        if (m.conn && t - m.lastSeen > c.staleMs) { const conn = m.conn; this.disconnect(conn); conn.close(4002, "stale"); }
        else if (!m.conn && m.disconnectedAt !== null && t - m.disconnectedAt > c.memberRejoinMs) this.removeMember(room.id, m.id, null);
      }
    }
  }

  // =====================================================================
  // Readiness (spec §6): "connected" is never enough
  // =====================================================================
  private stateOf(room: Room, m: Member): MemberState {
    if (!m.conn) return "disconnected";
    const r = m.report;
    if (!r || r.audioState !== "running") return "enabling_sound";
    const loaded = new Set(r.loadedAssetIds);
    if (r.manifestVersion !== room.manifest.version || room.manifest.assets.some(a => !loaded.has(a.assetId))) return "loading";
    const clockAge = r.clock ? r.clock.ageMs + (this.now() - r.reportedAt) : Infinity;
    if (!m.snapshotSent || !r.snapshotApplied || !r.clock || clockAge > this.config.maxClockAgeMs) return "synchronizing";
    if (m.degraded || r.clock.uncertaintyMs > this.config.maxClockUncertaintyMs) return "degraded";
    return "ready";
  }

  private refresh(room: Room, m: Member) {
    const s = this.stateOf(room, m);
    if (s !== m.state) { m.state = s; this.pushMembers(room); }
  }

  /** Host view: every phone's state, plus Connected / Ready counts. */
  private pushMembers(room: Room) {
    if (!room.hostConn) return;
    const members = [...room.members.values()].map(m => ({
      memberId: m.id, displayName: m.displayName, state: m.state, lateCues: m.lateCues, lastSkip: m.lastSkip,
      clockUncertaintyMs: m.report?.clock?.uncertaintyMs,
    }));
    room.hostConn.send({
      protocolVersion: PROTOCOL_VERSION, type: "room.members", roomId: room.id, locked: room.locked, muted: room.muted,
      connected: members.filter(m => m.state !== "disconnected").length, ready: members.filter(m => m.state === "ready").length, members,
    });
  }

  // =====================================================================
  // Sound (called in-process by the cue adapter; the host page reaches these only through host.* checks)
  // =====================================================================
  /** Replace the asset list. Phones load the new version; a phone isn't Ready until it has all of it. */
  setManifest(roomId: string, assets: Asset[]) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.manifest = { version: room.manifest.version + 1, assets };
    room.lastActivity = this.now();
    for (const m of room.members.values()) m.conn?.send({ protocolVersion: PROTOCOL_VERSION, type: "assets.manifest", roomId: room.id, ...room.manifest });
    for (const m of room.members.values()) this.refresh(room, m);
    return room.manifest.version;
  }

  /**
   * One shared cue, scheduled leadMs ahead, the same for every phone. A loop replaces the loop on its layer.
   * While muted, one-shots are dropped (never replayed later) and loops are only remembered for Resume.
   */
  playCue(roomId: string, input: CueInput): { cue: Cue } | { skipped: "muted" | "duplicate" } | { error: "not_found" | "unknown_asset" } {
    const room = this.rooms.get(roomId);
    if (!room) return { error: "not_found" };
    const asset = room.manifest.assets.find(a => a.assetId === input.assetId);
    if (!asset) return { error: "unknown_asset" };
    const cueId = input.cueId ?? this.rng.id();
    if (room.recentCueIds.has(cueId)) return { skipped: "duplicate" };
    this.remember(room, cueId);
    const t = this.now(), loop = !!input.loop;
    room.lastActivity = t;
    const playAtServerMs = t + this.config.leadMs;
    const cue: Cue = {
      cueId, assetId: asset.assetId, contentHash: asset.contentHash, layerId: input.layerId, playAtServerMs,
      offsetSeconds: input.offsetSeconds ?? 0, loop, gain: clamp01(input.gain), fadeInMs: input.fadeInMs ?? (loop ? 1500 : 10),
      fadeOutMs: input.fadeOutMs ?? (loop ? 1500 : 100), latePolicy: loop ? "join" : "skip", durationS: asset.durationS,
      ...(input.maxS !== undefined ? { maxS: input.maxS } : {}),
      // loop boundaries only when the asset defines them; otherwise phones loop the whole decoded buffer
      ...(loop ? { anchorServerMs: playAtServerMs } : {}),
      ...(loop && asset.loopStartSeconds !== undefined ? { loopStartSeconds: asset.loopStartSeconds } : {}),
      ...(loop && asset.loopEndSeconds !== undefined ? { loopEndSeconds: asset.loopEndSeconds } : {}),
    };
    if (loop) room.loops.set(cue.layerId, cue);
    if (room.muted) return loop ? { cue } : { skipped: "muted" };
    if (!loop) room.pending = [...room.pending.filter(c => c.playAtServerMs > t), cue];
    this.emit(room, { type: "cue.play", ...cue });
    return { cue };
  }

  /** Stop a layer's loop (or one cue) with a fade, at the shared time. */
  stopCue(roomId: string, target: { layerId?: string; cueId?: string }, fadeOutMs = 500) {
    const room = this.rooms.get(roomId);
    if (!room || (!target.layerId && !target.cueId)) return false;
    if (target.layerId) room.loops.delete(target.layerId);
    if (target.cueId) for (const [k, c] of room.loops) if (c.cueId === target.cueId) room.loops.delete(k);
    room.pending = room.pending.filter(c => c.cueId !== target.cueId && c.layerId !== target.layerId);
    if (!room.muted) this.emit(room, { type: "cue.stop", ...target, stopAtServerMs: this.now() + this.config.leadMs, fadeOutMs });
    return true;
  }

  /** Level of a looping layer (music / ambience follow the talk's tension). Remembered for snapshots and Resume. */
  setLayerGain(roomId: string, layerId: string, gain: number, rampMs = 1200) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const loop = room.loops.get(layerId);
    if (loop) loop.gain = clamp01(gain);
    if (!room.muted) this.emit(room, { type: "layer.gain", layerId, gain: clamp01(gain), atServerMs: this.now() + this.config.leadMs, rampMs });
    return true;
  }

  /** The presenter is speaking: every phone dips the beds at the same moment. */
  duck(roomId: string, holdMs = 2500, depth = 0.6) {
    const room = this.rooms.get(roomId);
    if (!room || room.muted) return false;
    this.emit(room, { type: "layer.duck", atServerMs: this.now() + this.config.leadMs, depth: clamp01(depth), holdMs });
    return true;
  }

  /** Mute all: new generation, so anything scheduled under the old one must not sound. Pending one-shots are gone for good. */
  mute(roomId: string, reason = "host") {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.generation++;
    room.muted = true; room.muteReason = reason; room.pending = [];
    this.emit(room, { type: "room.mute", muted: true, reason });
    this.pushMembers(room);
    return true;
  }

  /** Resume: loops come back at their current phase (same anchors); missed one-shots are not replayed. */
  resume(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room || !room.muted) return false;
    room.generation++;
    room.muted = false; room.muteReason = "";
    room.lastActivity = this.now();
    this.emit(room, { type: "room.resume", muted: false, resumeAtServerMs: this.now() + this.config.leadMs, loops: [...room.loops.values()] });
    this.pushMembers(room);
    return true;
  }

  /** The room a HOST token belongs to (member tokens don't count), for the separate microphone socket. */
  roomForHostToken(token: string): string | null {
    const who = this.tokens.get(hash(token));
    return who && !who.memberId && this.rooms.has(who.roomId) ? who.roomId : null;
  }

  /** Send something to this room's host, if connected (the talk panel's status). */
  sendToHost(roomId: string, msg: object) { this.rooms.get(roomId)?.hostConn?.send(msg); }

  // ---- reads, for the host process and tests ----
  roomIds() { return [...this.rooms.keys()]; }
  info(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return {
      id: room.id, code: room.code, locked: room.locked, muted: room.muted, generation: room.generation, sequence: room.sequence,
      manifestVersion: room.manifest.version, loops: [...room.loops.keys()], hostConnected: !!room.hostConn,
      members: [...room.members.values()].map(m => ({ id: m.id, displayName: m.displayName, state: m.state })),
    };
  }

  // =====================================================================
  private emit(room: Room, body: Record<string, unknown>) {
    const msg = { protocolVersion: PROTOCOL_VERSION, ...body, roomId: room.id, serverEpochId: this.serverEpochId, generation: room.generation, sequence: ++room.sequence };
    // every connected member gets every event (contiguous sequence numbers); a phone that isn't ready skips cues and says why
    for (const m of room.members.values()) m.conn?.send(msg);
  }

  private remember(room: Room, cueId: string) {
    room.recentCueIds.add(cueId);
    if (room.recentCueIds.size > this.config.cueCacheSize) room.recentCueIds.delete(room.recentCueIds.values().next().value!);
  }

  private error(conn: Conn, code: string, message: string) {
    conn.send({ protocolVersion: PROTOCOL_VERSION, type: "error", code, message });
  }
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
