// The browser's microphone for the web app: PCM conversion, Deepgram sentence assembly, and /api/mic end to end
// (theme phrase, talk words into the talk, token check, limits) with a fake speech service.
//   npm run test:mic
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { assembler, attachMic, type SttFactory } from "../micServer";
// @ts-ignore — the browser's worklet module, plain JS
import { Downsampler } from "../web/public/mic-worklet.js";

test("48 kHz float audio becomes 16 kHz 16-bit PCM, across chunks and odd rates", () => {
  const d = new Downsampler(48_000);
  const out = [...d.push(new Float32Array(4800).fill(0.5)), ...d.push(new Float32Array(4800).fill(-0.5))];
  assert.equal(out.length, 3200);
  assert.equal(out[0], 16383);
  assert.equal(out[3000], -16384);
  const odd = new Downsampler(44_100);
  let n = 0; for (let i = 0; i < 100; i++) n += odd.push(new Float32Array(441)).length;
  assert.ok(Math.abs(n - 16_000) <= 1, `${n}`);
  assert.equal(new Downsampler(48_000).push(new Float32Array(3).fill(9))[0], 32767);
});

test("Deepgram results assemble into the sentence so far and finished sentences; flush ends a theme", () => {
  const partial: string[] = [], final: string[] = [];
  const w = assembler({ partial: t => partial.push(t), final: t => final.push(t) });
  const r = (transcript: string, is_final = false, speech_final = false) => ({ type: "Results", is_final, speech_final, channel: { alternatives: [{ transcript }] } });
  w.feed(r("a haunted"));
  w.feed(r("a haunted lighthouse", true));
  w.feed(r("story", true, true));
  w.feed(r("on a stormy", true));
  w.flush();
  assert.deepEqual(final, ["a haunted lighthouse story", "on a stormy"]);
  assert.deepEqual(partial, ["a haunted", "a haunted lighthouse", "a haunted lighthouse story", "on a stormy"]);
});

// ---------------------------------------------------------------- end to end
// fake speech service: the "audio" is UTF-8 text; each frame becomes a partial then a final; finish() ends at once
type Heard = { keyterms: string[]; audio: string[] };
function rig(opts: { available?: boolean } = {}) {
  const heard: Heard[] = [];
  const stt: SttFactory = (keyterms, on) => {
    const me: Heard = { keyterms, audio: [] }; heard.push(me);
    return {
      send: pcm => { const t = pcm.toString("utf8").trim(); me.audio.push(t); on.partial(t.split(" ")[0]); on.final(t); },
      finish: ended => setTimeout(ended, 10),
      close: () => { },
    };
  };
  const talk = { token: null as string | null, words: [] as string[], keyterms: ["thunder"] };
  const server: Server = createServer();
  attachMic(server, { token: () => talk.token, keyterms: () => talk.keyterms, hear: (op, text) => talk.words.push(`${op}:${text}`) },
    { stt, sttAvailable: () => opts.available ?? true });
  const listening = new Promise<number>(ok => server.listen(0, "127.0.0.1", () => ok((server.address() as AddressInfo).port)));
  return { heard, talk, server, listening };
}
function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/mic`);
  const inbox: any[] = [];
  ws.on("message", (d, bin) => { if (!bin) inbox.push(JSON.parse(d.toString())); });
  const opened = new Promise<void>((ok, fail) => { ws.once("open", () => ok()); ws.once("error", fail); });
  const closed = new Promise<number>(ok => ws.once("close", c => ok(c)));
  const next = async (pred: (m: any) => boolean, ms = 5000) => {
    const t0 = Date.now();
    for (;;) { const m = inbox.find(pred); if (m) return m; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 10)); }
  };
  const start = (body: object) => ws.send(JSON.stringify({ type: "mic.start", ...body }));
  return { ws, inbox, opened, closed, next, start };
}

test("theme: the held phrase comes back as one text when the button is let go", async () => {
  const r = rig(); const port = await r.listening;
  try {
    const c = client(port); await c.opened;
    c.start({ mode: "theme" });
    await c.next(m => m.type === "mic.ready");
    c.ws.send(Buffer.from("a haunted lighthouse"));
    c.ws.send(Buffer.from("on a stormy night "));   // even byte counts, like real 16-bit audio
    await c.next(m => m.type === "mic.transcript" && m.final && m.text === "on a stormy night");
    c.ws.send(JSON.stringify({ type: "mic.stop" }));
    assert.equal((await c.next(m => m.type === "mic.done")).text, "a haunted lighthouse on a stormy night");
    assert.equal(await c.closed, 1000);
    assert.deepEqual(r.talk.words, []);                          // a theme never reaches the talk
    assert.deepEqual(r.heard[0].keyterms, []);
  } finally { r.server.close(); }
});

test("talk: words go to the talk as they're heard, with the talk's trigger words; the token is required", async () => {
  const r = rig(); const port = await r.listening;
  try {
    const none = client(port); await none.opened;
    none.start({ mode: "talk", token: "x" });
    assert.equal((await none.next(m => m.type === "mic.error")).code, "not_running");

    r.talk.token = "secret-talk-token";
    const wrong = client(port); await wrong.opened;
    wrong.start({ mode: "talk", token: "guess" });
    assert.equal((await wrong.next(m => m.type === "mic.error")).code, "unauthorized");
    assert.equal(await wrong.closed, 4003);

    const c = client(port); await c.opened;
    c.start({ mode: "talk", token: "secret-talk-token" });
    await c.next(m => m.type === "mic.ready");
    c.ws.send(Buffer.from("the thunder crashed "));
    await c.next(m => m.type === "mic.transcript" && m.final);
    assert.deepEqual(r.talk.words, ["partial:the", "final:the thunder crashed"]);
    assert.deepEqual(r.heard.at(-1)!.keyterms, ["thunder"]);

    const c2 = client(port); await c2.opened;              // a second phone takes over
    c2.start({ mode: "talk", token: "secret-talk-token" });
    await c2.next(m => m.type === "mic.ready");
    assert.equal((await c.next(m => m.type === "mic.error")).code, "replaced");

    r.talk.token = null;                                     // talk stopped
    c2.ws.send(Buffer.from("hello there "));
    assert.equal((await c2.next(m => m.type === "mic.error")).code, "not_running");
  } finally { r.server.close(); }
});

test("start message first, sane audio only, and a clear error without a speech key", async () => {
  const r = rig(); const port = await r.listening;
  try {
    const raw = client(port); await raw.opened;
    raw.ws.send(Buffer.alloc(3200));
    assert.equal((await raw.next(m => m.type === "mic.error")).code, "unauthorized");

    const big = client(port); await big.opened;
    big.start({ mode: "theme" });
    await big.next(m => m.type === "mic.ready");
    big.ws.send(Buffer.alloc(40_000));
    assert.equal(await big.closed, 1009);                    // frame over the limit

    const odd = client(port); await odd.opened;
    odd.start({ mode: "theme" });
    await odd.next(m => m.type === "mic.ready");
    odd.ws.send(Buffer.alloc(3201));
    assert.equal((await odd.next(m => m.type === "mic.error")).code, "bad_audio");
    assert.ok(r.heard.every(h => h.audio.length === 0));    // none of that reached the speech service
  } finally { r.server.close(); }

  const n = rig({ available: false }); const p2 = await n.listening;
  try {
    const c = client(p2); await c.opened;
    c.start({ mode: "theme" });
    assert.equal((await c.next(m => m.type === "mic.error")).code, "no_speech_service");
  } finally { n.server.close(); }
});

test("theme streams are rate-limited per address", async () => {
  const r = rig(); const port = await r.listening;
  try {
    const codes: string[] = [];
    for (let i = 0; i < 13; i++) {
      const c = client(port); await c.opened;
      c.start({ mode: "theme" });
      const m = await c.next(x => x.type === "mic.ready" || x.type === "mic.error");
      codes.push(m.type === "mic.ready" ? "ok" : m.code);
      c.ws.close(); await c.closed;
    }
    assert.equal(codes.filter(c => c === "ok").length, 12);
    assert.equal(codes.at(-1), "busy");
  } finally { r.server.close(); }
});
