// Room state, roles, readiness, cues, mute generations, reconnects and expiry — with fake sockets and a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomManager, type Conn, type RoomConfig } from "../room/rooms";

type Fake = Conn & { sent: any[]; closed: { code?: number; reason?: string } | null };
let n = 0;
function fakeConn(ip = "127.0.0.1"): Fake {
  const c: Fake = {
    id: `c${++n}`, ip, loopback: ip === "127.0.0.1", sent: [], closed: null,
    send: msg => c.sent.push(JSON.parse(JSON.stringify(msg))),
    close: (code, reason) => { c.closed = { code, reason }; },
  };
  return c;
}

function setup(config: Partial<RoomConfig> = {}, codes?: string[]) {
  let t = 10_000;
  let i = 0;
  const mgr = new RoomManager({ config, now: () => t, rng: codes ? { code: () => codes[i++ % codes.length] } : {} });
  const clock = { advance: (ms: number) => { t += ms; }, get now() { return t; } };
  const open = (ip?: string) => { const c = fakeConn(ip); mgr.connect(c); return c; };
  const send = (c: Fake, type: string, body: object = {}) => mgr.receive(c, JSON.stringify({ protocolVersion: 1, type, ...body }));
  const host = () => {
    const h = open();
    send(h, "room.create", { name: "demo" });
    const created = last(h, "room.created");
    return { h, roomId: created.roomId as string, code: created.code as string, token: created.hostToken as string };
  };
  const join = (code: string, name?: string) => {
    const p = open("192.168.1.20");
    send(p, "room.join", { code, ...(name ? { displayName: name } : {}) });
    return p;
  };
  const ready = (p: Fake, manifestVersion: number, ids: string[], clockDiag = { offsetMs: 5, uncertaintyMs: 10, rttMs: 20, ageMs: 0 }) =>
    send(p, "member.ready", { manifestVersion, loadedAssetIds: ids, audioState: "running", snapshotApplied: true, clock: clockDiag });
  return { mgr, clock, open, send, host, join, ready };
}
const last = (c: Fake, type: string) => [...c.sent].reverse().find(m => m.type === type);
const all = (c: Fake, type: string) => c.sent.filter(m => m.type === type);
const ASSETS = [
  { assetId: "thunder_0", contentHash: "h-thunder", url: "/files/thunder_0.mp3", mimeType: "audio/mpeg", durationS: 3 },
  { assetId: "music_calm_0", contentHash: "h-calm", url: "/files/music_calm_0.mp3", mimeType: "audio/mpeg", durationS: 30 },
];

test("create returns a six-digit code and a separate host token", () => {
  const s = setup();
  const { h, code, token } = s.host();
  assert.match(code, /^\d{6}$/);
  assert.ok(token.length >= 40 && token !== code);
  assert.equal(last(h, "room.members").connected, 0);
});

test("a phone can host by default; creation can be limited to the server's own machine", () => {
  const s = setup();
  const phone = s.open("192.168.1.50");
  s.send(phone, "room.create");
  assert.ok(last(phone, "room.created"));
  const s2 = setup({ allowRemoteCreate: false });
  const r2 = s2.open("192.168.1.50");
  s2.send(r2, "room.create");
  assert.equal(last(r2, "error").code, "create_forbidden");
});

test("the engine hears about created rooms, Start and closing — only Start from the host counts", () => {
  const seen: string[] = [];
  const s = setup();
  s.mgr.hooks = { created: id => seen.push(`created ${id}`), start: id => seen.push(`start ${id}`), closed: id => seen.push(`closed ${id}`) };
  const { h, roomId, code } = s.host();
  const p = s.join(code);
  s.send(p, "host.start");
  assert.equal(last(p, "error").code, "unauthorized");
  s.send(h, "host.start");
  s.send(h, "host.end");
  assert.deepEqual(seen, [`created ${roomId}`, `start ${roomId}`, `closed ${roomId}`]);
});

test("room creation is rate-limited", () => {
  const s = setup({ createPerMinute: 2 });
  for (let i = 0; i < 2; i++) s.host();
  const h = s.open();
  s.send(h, "room.create");
  assert.equal(last(h, "error").code, "rate_limited");
});

test("code collisions are retried; leading zeros work end to end", () => {
  const s = setup({}, ["000042", "000042", "777777"]);
  const a = s.host(), b = s.host();
  assert.equal(a.code, "000042");
  assert.equal(b.code, "777777");
  const p = s.join("000042", "Sam");
  const joined = last(p, "room.joined");
  assert.equal(joined.roomId, a.roomId);
  assert.equal(joined.displayName, "Sam");
  assert.ok(joined.token);
  assert.deepEqual(p.sent.map(m => m.type), ["room.joined", "assets.manifest", "room.snapshot"]);
  const view = last(a.h, "room.members");                     // the host sees the new phone straight away
  assert.equal(view.connected, 1);
  assert.equal(view.members[0].displayName, "Sam");
});

test("wrong codes give a clear error and are rate-limited", () => {
  const s = setup({ badJoinsPerMinute: 3 });
  const { code } = s.host();
  const p = s.open("10.0.0.9");
  for (let i = 0; i < 3; i++) { s.send(p, "room.join", { code: "999999" }); assert.equal(last(p, "error").code, "invalid_code"); }
  s.send(p, "room.join", { code });
  assert.equal(last(p, "error").code, "rate_limited");          // even the right code, until the window passes
  s.clock.advance(60_001);
  s.send(p, "room.join", { code });
  assert.ok(last(p, "room.joined"));
});

test("locked and full rooms refuse joins with distinct errors", () => {
  const s = setup({ maxParticipants: 2 });
  const { h, code } = s.host();
  s.join(code); s.join(code);
  assert.equal(last(s.join(code), "error").code, "room_full");
  const s2 = setup();
  const r = s2.host();
  s2.send(r.h, "host.lock", { locked: true });
  assert.equal(last(s2.join(r.code), "error").code, "room_locked");
  s2.send(r.h, "host.lock", { locked: false });
  assert.ok(last(s2.join(r.code), "room.joined"));
  void h;
});

test("participants cannot play, mute, remove or close", () => {
  const s = setup();
  const { roomId, code } = s.host();
  s.mgr.setManifest(roomId, ASSETS);
  const p = s.join(code);
  const other = s.join(code);
  const memberId = last(other, "room.joined").memberId;
  for (const [type, body] of [["host.mute", {}], ["host.end", {}], ["host.test", {}], ["host.remove", { memberId }], ["host.lock", { locked: true }]] as const) {
    s.send(p, type, body);
    assert.equal(last(p, "error").code, "unauthorized", type);
  }
  const info = s.mgr.info(roomId)!;
  assert.equal(info.muted, false);
  assert.equal(info.locked, false);
  assert.equal(info.members.length, 2);
  assert.equal(all(other, "cue.play").length, 0);
  // and a socket that never joined can't sync or ask for state
  const stranger = s.open("10.0.0.1");
  s.send(stranger, "sync.request", { requestId: 1, c0: 0 });
  assert.equal(last(stranger, "error").code, "unauthorized");
});

test("Ready needs audio, every asset, a fresh clock and the snapshot — not just a socket", () => {
  const s = setup();
  const { h, roomId, code } = s.host();
  const v = s.mgr.setManifest(roomId, ASSETS)!;
  const p = s.join(code);
  const state = () => s.mgr.info(roomId)!.members[0].state;
  assert.equal(state(), "enabling_sound");
  s.send(p, "member.ready", { manifestVersion: v, loadedAssetIds: [], audioState: "suspended", snapshotApplied: true });
  assert.equal(state(), "enabling_sound");
  s.ready(p, v, ["thunder_0"]);
  assert.equal(state(), "loading");
  s.send(p, "member.ready", { manifestVersion: v, loadedAssetIds: ["thunder_0", "music_calm_0"], audioState: "running", snapshotApplied: true });
  assert.equal(state(), "synchronizing");                     // no clock estimate yet
  s.ready(p, v, ["thunder_0", "music_calm_0"]);
  assert.equal(state(), "ready");
  assert.equal(last(h, "room.members").ready, 1);
  s.ready(p, v, ["thunder_0", "music_calm_0"], { offsetMs: 0, uncertaintyMs: 400, rttMs: 800, ageMs: 0 });
  assert.equal(state(), "degraded");
  s.ready(p, v, ["thunder_0", "music_calm_0"]);
  s.send(p, "member.status", { state: "degraded", lateCues: 3 });
  assert.equal(state(), "degraded");
  s.ready(p, v, ["thunder_0", "music_calm_0"]);
  s.mgr.setManifest(roomId, [...ASSETS, { ...ASSETS[0], assetId: "door_0", contentHash: "h-door" }]);
  assert.equal(state(), "loading");                           // a new asset arrived and isn't loaded yet
});

test("cues are shared, scheduled ahead, numbered in order and isolated per room", () => {
  const s = setup({ leadMs: 400 });
  const a = s.host(), b = s.host();
  s.mgr.setManifest(a.roomId, ASSETS); s.mgr.setManifest(b.roomId, ASSETS);
  const p1 = s.join(a.code), p2 = s.join(a.code), q = s.join(b.code);
  const r = s.mgr.playCue(a.roomId, { assetId: "thunder_0", layerId: "sfx", gain: 0.7 });
  assert.ok("cue" in r);
  s.mgr.playCue(a.roomId, { assetId: "music_calm_0", layerId: "music", gain: 0.3, loop: true });
  const c1 = all(p1, "cue.play"), c2 = all(p2, "cue.play");
  assert.equal(c1.length, 2);
  assert.deepEqual(c1, c2);                                   // every phone gets the identical cue
  assert.equal(c1[0].playAtServerMs, s.clock.now + 400);
  assert.equal(c1[0].contentHash, "h-thunder");
  assert.equal(c1[0].latePolicy, "skip");
  assert.equal(c1[1].sequence, c1[0].sequence + 1);
  assert.equal(c1[1].anchorServerMs, c1[1].playAtServerMs);
  assert.equal(c1[1].latePolicy, "join");
  assert.equal(all(q, "cue.play").length, 0);
  assert.deepEqual(s.mgr.playCue(a.roomId, { assetId: "nope", layerId: "sfx", gain: 1 }), { error: "unknown_asset" });
});

test("a duplicate cueId plays once", () => {
  const s = setup();
  const { roomId, code } = s.host();
  s.mgr.setManifest(roomId, ASSETS);
  const p = s.join(code);
  s.mgr.playCue(roomId, { assetId: "thunder_0", layerId: "sfx", gain: 1, cueId: "cue-1" });
  assert.deepEqual(s.mgr.playCue(roomId, { assetId: "thunder_0", layerId: "sfx", gain: 1, cueId: "cue-1" }), { skipped: "duplicate" });
  assert.equal(all(p, "cue.play").length, 1);
});

test("mute bumps the generation, drops one-shots, and resume brings loops back at their old anchor", () => {
  const s = setup();
  const { h, roomId, code } = s.host();
  s.mgr.setManifest(roomId, ASSETS);
  const p = s.join(code);
  const loop = s.mgr.playCue(roomId, { assetId: "music_calm_0", layerId: "music", gain: 0.3, loop: true }) as any;
  const gen0 = s.mgr.info(roomId)!.generation;
  s.send(h, "host.mute");
  const mute = last(p, "room.mute");
  assert.equal(mute.generation, gen0 + 1);
  assert.equal(mute.muted, true);
  assert.deepEqual(s.mgr.playCue(roomId, { assetId: "thunder_0", layerId: "sfx", gain: 1 }), { skipped: "muted" });
  s.mgr.setLayerGain(roomId, "music", 0.5);
  assert.equal(all(p, "cue.play").length, 1);                 // nothing new sent while muted
  s.clock.advance(20_000);
  s.send(h, "host.resume");
  const res = last(p, "room.resume");
  assert.equal(res.generation, gen0 + 2);
  assert.equal(res.loops.length, 1);
  assert.equal(res.loops[0].anchorServerMs, loop.cue.anchorServerMs); // same timeline: phones join at the current phase
  assert.equal(res.loops[0].gain, 0.5);                       // the level change made while muted is kept
  assert.equal(all(p, "cue.play").length, 1);                 // the thunder missed while muted is never replayed
});

test("a phone that reconnects gets a fresh snapshot, and a muted room stays muted", () => {
  const s = setup();
  const { h, roomId, code } = s.host();
  s.mgr.setManifest(roomId, ASSETS);
  const p = s.join(code);
  const token = last(p, "room.joined").token;
  s.mgr.playCue(roomId, { assetId: "music_calm_0", layerId: "music", gain: 0.3, loop: true });
  s.send(h, "host.mute");
  s.mgr.disconnect(p);
  assert.equal(s.mgr.info(roomId)!.members[0].state, "disconnected");
  const p2 = s.open("192.168.1.20");
  s.send(p2, "room.auth", { token });
  const joined = last(p2, "room.joined");
  assert.equal(joined.token, undefined);                      // the token isn't re-issued
  const snap = last(p2, "room.snapshot");
  assert.equal(snap.muted, true);
  assert.equal(snap.loops.length, 1);
  assert.equal(snap.sequence, s.mgr.info(roomId)!.sequence);
  assert.equal(s.mgr.info(roomId)!.members.length, 1);        // same member, not a new one
});

test("snapshots carry pending one-shots so a phone that just joined doesn't lose a cue in flight", () => {
  const s = setup();
  const { roomId, code } = s.host();
  s.mgr.setManifest(roomId, ASSETS);
  s.mgr.playCue(roomId, { assetId: "thunder_0", layerId: "sfx", gain: 1 });
  const p = s.join(code);
  assert.equal(last(p, "room.snapshot").pendingCues.length, 1);
  s.clock.advance(1000);
  s.send(p, "snapshot.request");
  assert.equal(last(p, "room.snapshot").pendingCues.length, 0);
});

test("host loss mutes the room; a returning host must resume; no return closes it", () => {
  const s = setup({ hostGraceMs: 60_000 });
  const { h, roomId, code, token } = s.host();
  const p = s.join(code);
  s.mgr.disconnect(h);
  assert.equal(last(p, "room.mute").reason, "host_disconnected");
  const h2 = s.open();
  s.send(h2, "host.resume");                                  // not authenticated yet
  assert.equal(last(h2, "error").code, "unauthorized");
  s.send(h2, "room.auth", { token });
  assert.equal(last(h2, "room.joined").muted, true);
  assert.equal(s.mgr.info(roomId)!.muted, true);
  s.send(h2, "host.resume");
  assert.equal(s.mgr.info(roomId)!.muted, false);

  s.mgr.disconnect(h2);
  s.clock.advance(60_001);
  s.mgr.tick();
  assert.equal(last(p, "room.closed").reason, "host_timeout");
  assert.equal(s.mgr.info(roomId), null);
  const late = s.open();
  s.send(late, "room.auth", { token });
  assert.equal(last(late, "error").code, "unauthorized");
});

test("end room invalidates the code and every token at once", () => {
  const s = setup();
  const { h, code } = s.host();
  const p = s.join(code);
  const token = last(p, "room.joined").token;
  s.send(h, "host.end");
  assert.equal(last(p, "room.closed").reason, "ended");
  assert.ok(p.closed);
  assert.equal(last(s.join(code), "error").code, "invalid_code");
  const again = s.open();
  s.send(again, "room.auth", { token });
  assert.equal(last(again, "error").code, "unauthorized");
});

test("host can remove a phone; its token stops working", () => {
  const s = setup();
  const { h, code } = s.host();
  const p = s.join(code);
  const { memberId, token } = last(p, "room.joined");
  s.send(h, "host.remove", { memberId });
  assert.equal(last(p, "room.closed").reason, "removed");
  const back = s.open();
  s.send(back, "room.auth", { token });
  assert.equal(last(back, "error").code, "unauthorized");
  s.send(h, "host.remove", { memberId });
  assert.equal(last(h, "error").code, "not_found");
});

test("silent phones go stale, then lose their slot", () => {
  const s = setup({ staleMs: 15_000, memberRejoinMs: 60_000 });
  const { h, roomId, code } = s.host();
  const p = s.join(code);
  s.clock.advance(10_000);
  s.send(p, "member.status", {});                             // heartbeat keeps it alive
  s.send(h, "host.lock", { locked: false });                  // host activity
  s.clock.advance(10_000);
  s.mgr.tick();
  assert.equal(p.closed, null);
  s.clock.advance(6_000);
  s.mgr.tick();
  assert.deepEqual(p.closed, { code: 4002, reason: "stale" });
  assert.equal(s.mgr.info(roomId)!.members[0].state, "disconnected");
  s.clock.advance(60_001);
  s.mgr.tick();
  assert.equal(s.mgr.info(roomId)!.members.length, 0);
});

test("rooms expire after their lifetime and after going idle", () => {
  const s = setup({ lifetimeMs: 4 * 3600_000, idleMs: 30 * 60_000 });
  const a = s.host();
  for (let i = 0; i < 8; i++) { s.clock.advance(29 * 60_000); s.send(a.h, "host.lock", { locked: false }); s.mgr.tick(); }
  assert.ok(s.mgr.info(a.roomId));                            // 3 h 52 min, kept busy: still open
  s.clock.advance(9 * 60_000);
  s.mgr.tick();
  assert.equal(last(a.h, "room.closed").reason, "expired");   // past 4 h however busy
  assert.equal(s.mgr.info(a.roomId), null);
  const s2 = setup({ idleMs: 30 * 60_000 });
  const b = s2.host();
  s2.clock.advance(30 * 60_000 + 1);
  s2.mgr.tick();
  assert.equal(s2.mgr.info(b.roomId), null);
});

test("sync replies echo c0, give s1 ≤ s2 and the epoch, and are rate-limited", () => {
  const s = setup({ syncPerSecond: 5 });
  const { code } = s.host();
  const p = s.join(code);
  s.send(p, "sync.request", { requestId: 7, c0: 123.25 });
  const r = last(p, "sync.response");
  assert.equal(r.requestId, 7);
  assert.equal(r.c0, 123.25);
  assert.ok(r.s1 <= r.s2);
  assert.equal(r.serverEpochId, s.mgr.serverEpochId);
  for (let i = 0; i < 5; i++) s.send(p, "sync.request", { requestId: i, c0: 0 });
  assert.equal(last(p, "error").code, "rate_limited");
  assert.notEqual(new RoomManager().serverEpochId, new RoomManager().serverEpochId); // restart → new epoch
});

test("host test sound goes through the same cue path", () => {
  const s = setup();
  const { h, roomId, code } = s.host();
  const p = s.join(code);
  s.send(h, "host.test");
  assert.equal(last(h, "error").code, "unknown_asset");       // nothing loaded yet
  s.mgr.setManifest(roomId, ASSETS);
  s.send(h, "host.test", { assetId: "thunder_0" });
  const cue = last(p, "cue.play");
  assert.equal(cue.layerId, "test");
  assert.equal(cue.assetId, "thunder_0");
  s.send(h, "host.test");
  assert.equal(last(p, "cue.play").assetId, "thunder_0");     // default: the shortest sound, not the music bed
});
