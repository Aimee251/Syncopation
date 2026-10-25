// The host phone's microphone: PCM conversion, Deepgram sentence assembly, and the /room/mic socket end to end
// (host-only, talk must be running, size limits) with a fake speech service and the fake talk process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { assembler, type SttFactory } from "../room/deepgram";
import { startRoomHost } from "../room/host";
// @ts-ignore — browser worklet module, plain JS
import { Downsampler } from "../public/room/mic-worklet.js";

test("48 kHz float audio becomes 16 kHz 16-bit PCM, across chunk boundaries", () => {
  const d = new Downsampler(48_000);
  const out = [...d.push(new Float32Array(4800).fill(0.5)), ...d.push(new Float32Array(4800).fill(-0.5))];
  assert.equal(out.length, 3200);                         // 200 ms
  assert.equal(out[0], 16383);                             // 0.5 → half scale
  assert.equal(out[3000], -16384);                         // −0.5 → half scale, negative
  const odd = new Downsampler(44_100);                    // non-integer ratio keeps the right count over time
  let n = 0; for (let i = 0; i < 100; i++) n += odd.push(new Float32Array(441)).length;
  assert.ok(Math.abs(n - 16_000) <= 1, `${n}`);
  assert.equal(new Downsampler(48_000).push(new Float32Array(3).fill(9))[0], 32767);   // clipped, not wrapped
});

test("Deepgram results assemble into the sentence so far and the finished sentence", () => {
  const partial: string[] = [], final: string[] = [];
  const feed = assembler({ partial: t => partial.push(t), final: t => final.push(t) });
  const r = (transcript: string, is_final = false, speech_final = false) => ({ type: "Results", is_final, speech_final, channel: { alternatives: [{ transcript }] } });
  feed(r("the thun"));
  feed(r("the thunder", true));
  feed(r("crashed"));
  feed(r("crashed", true, true));                          // pause: sentence done
  feed(r("and then"));
  feed(r("and then", true));
  feed({ type: "UtteranceEnd" });                          // backup end of sentence
  feed({ type: "Metadata" });
  assert.deepEqual(partial, ["the thun", "the thunder", "the thunder crashed", "and then"]);
  assert.deepEqual(final, ["the thunder crashed", "and then"]);
});

// ---------------------------------------------------------------- end to end
function client(url: string) {
  const ws = new WebSocket(url);
  const inbox: any[] = [];
  ws.on("message", (d, bin) => { if (!bin) inbox.push(JSON.parse(d.toString())); });
  const opened = new Promise<void>((ok, fail) => { ws.once("open", () => ok()); ws.once("error", fail); });
  const closed = new Promise<number>(ok => ws.once("close", code => ok(code)));
  const send = (type: string, body: object = {}) => ws.send(JSON.stringify({ protocolVersion: 1, type, ...body }));
  const next = async (pred: (m: any) => boolean, ms = 15_000) => {
    const t0 = Date.now();
    for (;;) { const m = inbox.find(pred); if (m) return m; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 20)); }
  };
  return { ws, inbox, opened, closed, send, next };
}

async function rig() {
  const root = mkdtempSync(join(tmpdir(), "sync-mic-"));
  const dir = join(root, "spooky_1");
  mkdirSync(join(dir, "sounds"), { recursive: true });
  writeFileSync(join(dir, "sounds", "thunder_0.mp3"), Buffer.from("fake thunder"));
  writeFileSync(join(dir, "sounds", "music_calm_0.mp3"), Buffer.from("fake music"));
  writeFileSync(join(dir, "library.json"), JSON.stringify({ sounds: [] }));
  writeFileSync(join(dir, "setup.json"), JSON.stringify({ theme: "spooky" }));
  const heardBy: { keyterms: string[]; audio: string[] }[] = [];
  // fake speech service: the "audio" is UTF-8 text; it echoes it back as a partial, then a final sentence
  const stt: SttFactory = (keyterms, on) => {
    const me = { keyterms, audio: [] as string[] }; heardBy.push(me);
    return { send: pcm => { const t = pcm.toString("utf8").trim(); me.audio.push(t); on.partial(t.split(" ").slice(0, 2).join(" ")); on.final(t); }, close: () => { } };
  };
  const host = await startRoomHost({
    port: 0, host: "127.0.0.1", stt,
    talks: {
      sessionsDir: root,
      spawnTalk: ({ library, setup }) => spawn(process.execPath, ["--import", "tsx", "tests/fixtures/fakeTalk.ts", "--library", library, "--setup", setup, "--type"],
        { stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, SYNC_ROOM_IPC: "1" } }),
    },
  });
  const base = `ws://127.0.0.1:${host.server.port}`;
  const h = client(`${base}/room`); await h.opened;
  h.send("room.create");
  const created = await h.next(m => m.type === "room.created");
  const p = client(`${base}/room`); await p.opened;
  p.send("room.join", { code: created.code });
  const joined = await p.next(m => m.type === "room.joined");
  return { root, host, base, h, p, hostToken: created.hostToken as string, memberToken: joined.token as string, heardBy,
    async done() { h.ws.close(); p.ws.close(); await host.server.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("the host's microphone drives the talk: spoken words → transcript, log and shared cues", async () => {
  const r = await rig();
  try {
    // before the talk runs, the mic is refused
    const early = client(`${r.base}/room/mic`); await early.opened;
    early.ws.send(JSON.stringify({ protocolVersion: 1, type: "mic.auth", token: r.hostToken }));
    assert.equal((await early.next(m => m.type === "mic.error")).code, "not_running");

    r.h.send("host.useSession", { sessionId: "spooky_1" });
    await r.h.next(m => m.type === "talk.status" && m.phase === "ready");
    r.h.send("host.start");
    await r.p.next(m => m.type === "cue.play" && m.loop);                       // talk process is up (music bed)

    const mic = client(`${r.base}/room/mic`); await mic.opened;
    mic.ws.send(JSON.stringify({ protocolVersion: 1, type: "mic.auth", token: r.hostToken }));
    await mic.next(m => m.type === "mic.ready");
    mic.ws.send(Buffer.from("the thunder crashed "));                            // even length, like real PCM
    assert.equal((await mic.next(m => m.type === "mic.transcript" && m.final)).text, "the thunder crashed");
    assert.ok(mic.inbox.some(m => m.type === "mic.transcript" && !m.final && m.text === "the thunder"));
    await r.p.next(m => m.type === "cue.play" && m.assetId.startsWith("thunder_0"));
    await r.h.next(m => m.type === "talk.status" && m.log?.includes("[HEARD] the thunder crashed"));
    await r.h.next(m => m.type === "talk.status" && m.log?.includes("[STREAM] the thunder"));
    assert.deepEqual(r.heardBy.at(-1)!.keyterms, ["thunder", "music calm"]);  // the talk's trigger words reached the speech model

    // a second microphone takes over; the first is told why
    const mic2 = client(`${r.base}/room/mic`); await mic2.opened;
    mic2.ws.send(JSON.stringify({ protocolVersion: 1, type: "mic.auth", token: r.hostToken }));
    await mic2.next(m => m.type === "mic.ready");
    assert.equal((await mic.next(m => m.type === "mic.error")).code, "replaced");

    // talk ends → the next audio frame is refused
    r.h.send("host.command", { command: "end" });
    await r.h.next(m => m.type === "talk.status" && m.phase === "ended");
    mic2.ws.send(Buffer.from("hello there "));
    assert.equal((await mic2.next(m => m.type === "mic.error")).code, "not_running");
  } finally { await r.done(); }
});

test("only the host may stream, credentials come first, and oversized audio is cut off", async () => {
  const r = await rig();
  try {
    r.h.send("host.useSession", { sessionId: "spooky_1" });
    await r.h.next(m => m.type === "talk.status" && m.phase === "ready");
    r.h.send("host.start");
    await r.p.next(m => m.type === "cue.play" && m.loop);

    const member = client(`${r.base}/room/mic`); await member.opened;
    member.ws.send(JSON.stringify({ protocolVersion: 1, type: "mic.auth", token: r.memberToken }));
    assert.equal((await member.next(m => m.type === "mic.error")).code, "unauthorized");
    assert.equal(await member.closed, 4003);

    const raw = client(`${r.base}/room/mic`); await raw.opened;
    raw.ws.send(Buffer.alloc(3200));                                              // audio before credentials
    assert.equal((await raw.next(m => m.type === "mic.error")).code, "unauthorized");

    const big = client(`${r.base}/room/mic`); await big.opened;
    big.ws.send(JSON.stringify({ protocolVersion: 1, type: "mic.auth", token: r.hostToken }));
    await big.next(m => m.type === "mic.ready");
    big.ws.send(Buffer.alloc(40_000));                                            // over the frame limit
    assert.equal(await big.closed, 1009);                                          // message too big

    const odd = client(`${r.base}/room/mic`); await odd.opened;
    odd.ws.send(JSON.stringify({ protocolVersion: 1, type: "mic.auth", token: r.hostToken }));
    await odd.next(m => m.type === "mic.ready");
    odd.ws.send(Buffer.alloc(3201));                                               // not 16-bit samples
    assert.equal((await odd.next(m => m.type === "mic.error")).code, "bad_audio");
    assert.equal(r.heardBy.every(h => h.audio.length === 0), true);              // nothing above reached the speech service
  } finally { await r.done(); }
});
