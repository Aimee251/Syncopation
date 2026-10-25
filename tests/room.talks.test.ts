// Server-run talks: setup or a saved session → ready (phones get the sounds) → Start spawns a talk process per room →
// typed lines go in, its sound decisions come back over IPC as room cues → end. Uses tests/fixtures/fakeTalk.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomManager, type Conn } from "../room/rooms";
import { TalkManager, type BuildFn } from "../room/talks";
import { applyBridge } from "../room/talkBridge";
import { RoomEngine } from "../room/engine";

type Fake = Conn & { sent: any[] };
let n = 0;
const fakeConn = (ip = "127.0.0.1"): Fake => { const c: Fake = { id: `t${++n}`, ip, loopback: true, sent: [], send: m => c.sent.push(JSON.parse(JSON.stringify(m))), close: () => { } }; return c; };
const last = (c: Fake, type: string) => [...c.sent].reverse().find(m => m.type === type);
const until = async (cond: () => unknown, ms = 15_000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 25)); } };

function session(root: string, id: string, theme: string) {
  const dir = join(root, id);
  mkdirSync(join(dir, "sounds"), { recursive: true });
  writeFileSync(join(dir, "sounds", "thunder_0.mp3"), Buffer.from("fake thunder"));
  writeFileSync(join(dir, "sounds", "music_calm_0.mp3"), Buffer.from("fake music"));
  writeFileSync(join(dir, "library.json"), JSON.stringify({ sounds: [{ url: "/sounds/thunder_0.mp3", durationMs: 1200 }, { url: "/sounds/music_calm_0.mp3", durationMs: 30_000 }] }));
  writeFileSync(join(dir, "setup.json"), JSON.stringify({ theme, minutes: 3 }));
  return dir;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sync-talks-"));
  session(root, "spooky_1", "spooky story");
  const mgr = new RoomManager();
  const build: BuildFn = async (s, dir, progress) => {
    progress({ completed: 1, total: 2, message: "searching" });
    mkdirSync(join(dir, "sounds"), { recursive: true });
    writeFileSync(join(dir, "sounds", "door_0.mp3"), Buffer.from("fake door"));
    writeFileSync(join(dir, "library.json"), JSON.stringify({ sounds: [{ url: "/sounds/door_0.mp3", durationMs: 900 }] }));
    progress({ completed: 2, total: 2, message: "done" });
  };
  const talks = new TalkManager(mgr, {
    sessionsDir: root, build,
    spawnTalk: ({ library, setup }) => spawn(process.execPath, ["--import", "tsx", "tests/fixtures/fakeTalk.ts", "--library", library, "--setup", setup, "--type"],
      { stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, SYNC_ROOM_IPC: "1" } }),
  });
  mgr.hooks = talks.hooks();
  const send = (c: Fake, type: string, body: object = {}) => mgr.receive(c, JSON.stringify({ protocolVersion: 1, type, ...body }));
  const h = fakeConn(); mgr.connect(h); send(h, "room.create");
  const { roomId, code } = last(h, "room.created");
  const p = fakeConn("192.168.1.9"); mgr.connect(p); send(p, "room.join", { code });
  return { root, mgr, talks, h, p, roomId, send, cleanup: () => { mgr.endRoom(roomId, "ended"); rmSync(root, { recursive: true, force: true }); } };
}

test("a new room starts in setup and lists saved stories", () => {
  const s = setup();
  try {
    const st = last(s.h, "talk.status");
    assert.equal(st.phase, "setup");
    assert.deepEqual(st.saved, [{ id: "spooky_1", theme: "spooky story" }]);
  } finally { s.cleanup(); }
});

test("Start before the sounds are ready is refused with a reason", () => {
  const s = setup();
  try {
    s.send(s.h, "host.start");
    assert.equal(last(s.h, "talk.status").phase, "setup");
    assert.match(last(s.h, "talk.status").error, /sounds first/);
  } finally { s.cleanup(); }
});

test("building a new story reports progress, writes setup.json and hands the sounds to the phones", async () => {
  const s = setup();
  try {
    s.send(s.h, "host.setup", { theme: "Haunted lighthouse", minutes: 7, sounds: "foghorn, waves" });
    await until(() => last(s.h, "talk.status")?.phase === "ready");
    const phases = s.h.sent.filter(m => m.type === "talk.status").map(m => m.phase);
    assert.ok(phases.includes("building"));
    const st = last(s.h, "talk.status");
    assert.equal(st.theme, "Haunted lighthouse");
    assert.equal(st.sounds, 1);
    const written = JSON.parse(readFileSync(join(s.root, st.sessionId, "setup.json"), "utf8"));
    assert.equal(written.minutes, 7);
    assert.deepEqual(written.keywords, ["foghorn", "waves"]);
    assert.equal(last(s.p, "assets.manifest").assets.length, 1);
  } finally { s.cleanup(); }
});

test("a saved story runs as its own process: typed lines become shared cues; /end finishes it", async () => {
  const s = setup();
  try {
    s.send(s.h, "host.useSession", { sessionId: "spooky_1" });
    assert.equal(last(s.h, "talk.status").phase, "ready");
    const manifest = last(s.p, "assets.manifest");
    assert.equal(manifest.assets.length, 2);
    assert.equal(manifest.assets.find((a: any) => a.assetId.startsWith("thunder_0")).durationS, 1.2);

    s.send(s.h, "host.start");
    assert.equal(last(s.h, "talk.status").phase, "running");
    await until(() => s.p.sent.some(m => m.type === "cue.play" && m.loop));       // the child started the music bed
    s.send(s.h, "host.say", { text: "then the thunder crashed" });
    await until(() => s.p.sent.some(m => m.type === "cue.play" && m.assetId.startsWith("thunder_0")));
    const thunder = s.p.sent.find(m => m.type === "cue.play" && m.assetId.startsWith("thunder_0"));
    assert.equal(thunder.gain, 0.8);
    assert.equal(thunder.fadeOutMs, 200);
    await until(() => s.h.sent.some(m => m.type === "talk.status" && m.log?.some((l: string) => l === "[HEARD] then the thunder crashed"))); // colour codes stripped

    s.send(s.h, "host.command", { command: "end" });
    await until(() => last(s.h, "talk.status")?.phase === "ended");
    assert.ok(s.p.sent.some(m => m.type === "cue.stop" && m.layerId === "music"));
    assert.ok(last(s.h, "talk.status").saved?.length);                          // the next talk can be chosen…
    session(s.root, "comedy_2", "comedy night");
    s.send(s.h, "host.useSession", { sessionId: "comedy_2" });
    assert.equal(last(s.h, "talk.status").phase, "ready");                       // …in the same room
    const next = last(s.p, "assets.manifest");
    assert.equal(next.assets.length, 2);                                         // only the new story's sounds, not 4
  } finally { s.cleanup(); }
});

test("typed text can't become a command, and members can't drive the talk", async () => {
  const s = setup();
  try {
    s.send(s.h, "host.useSession", { sessionId: "spooky_1" });
    s.send(s.h, "host.start");
    s.send(s.h, "host.say", { text: "/end" });                                    // arrives as the sentence "end"
    await until(() => s.h.sent.some(m => m.type === "talk.status" && m.log?.includes("[HEARD] end")));
    assert.equal(s.talks.phase(s.roomId), "running");
    for (const type of ["host.say", "host.setup", "host.useSession", "host.command"]) {
      s.send(s.p, type, type === "host.say" ? { text: "x" } : type === "host.setup" ? { theme: "x" } : type === "host.useSession" ? { sessionId: "spooky_1" } : { command: "end" });
      assert.equal(last(s.p, "error").code, "unauthorized", type);
    }
    s.send(s.h, "host.useSession", { sessionId: "../../etc" });
    assert.equal(last(s.h, "error").code, "bad_message");
  } finally { s.cleanup(); }
});

test("a talk can only play files from its own session folder", async () => {
  const s = setup();
  try {
    s.send(s.h, "host.useSession", { sessionId: "spooky_1" });
    s.send(s.h, "host.start");
    await until(() => s.p.sent.some(m => m.type === "cue.play"));
    const before = s.p.sent.filter(m => m.type === "cue.play").length;
    s.send(s.h, "host.say", { text: "something outside" });
    await until(() => s.h.sent.some(m => m.type === "talk.status" && m.log?.includes("[HEARD] something outside")));
    await new Promise(r => setTimeout(r, 200));
    assert.equal(s.p.sent.filter(m => m.type === "cue.play").length, before);
    // and directly: the parent-side check
    const e = new RoomEngine("r"); e.manager = s.mgr;
    assert.equal(applyBridge(e, { op: "playOnce", file: "C:/Windows/win.ini", gain: 1, opts: {} }, join(s.root, "spooky_1") + "\\"), false);
    assert.equal(applyBridge(e, { op: "setLevel", layer: "music", level: 5 }, s.root), false);
    assert.equal(applyBridge(e, { op: "setLoop", layer: "vocals", file: null, level: 0.2 }, s.root), false);
  } finally { s.cleanup(); }
});

test("closing the room stops its talk process", async () => {
  const s = setup();
  s.send(s.h, "host.useSession", { sessionId: "spooky_1" });
  s.send(s.h, "host.start");
  await until(() => s.p.sent.some(m => m.type === "cue.play"));
  const child = (s.talks as any).talks.get(s.roomId).child;
  const exited = new Promise(r => child.once("exit", r));
  s.mgr.endRoom(s.roomId, "ended");
  await exited;
  assert.equal(s.talks.phase(s.roomId), undefined);
  rmSync(s.root, { recursive: true, force: true });
});
