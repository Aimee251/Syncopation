// micServer.ts — the browser's microphone for the web app (WebSocket /api/mic on server.ts), so the talk works from any
// phone instead of only hearing the laptop that runs the backend.
//
//   browser → { type: "mic.start", mode: "theme" }                  the held "what's your story about?" phrase
//   browser → { type: "mic.start", mode: "talk", token }            the talk (token from POST /api/talk)
//   browser → binary frames: 16 kHz mono 16-bit PCM, ~100 ms each
//   browser → { type: "mic.stop" }                                  theme: let go of the button
//   server  → mic.ready | mic.transcript { text, final } | mic.done { text } (theme) | mic.error { code, message }
//
// Speech-to-text runs here (Deepgram, same settings as stt.ts), so the API key never reaches the browser. In talk mode
// the words go to predict.ts (--remote-mic) as they're heard. Audio is not stored.
// The page is on another site (Vercel) and reaches this through a tunnel, so any origin may connect, like the /api
// routes: a talk needs its token, and theme streams are short and rate-limited.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

export type SttEvents = { partial(text: string): void; final(text: string): void; error(message: string): void };
export interface SttStream { send(pcm: Buffer): void; /** stop listening; pending words still arrive, then ended() */ finish(ended: () => void): void; close(): void }
export type SttFactory = (keyterms: string[], on: SttEvents) => SttStream;

export const LIMITS = {
  maxFrameBytes: 32_000,       // 1 s of audio in one frame is already generous
  maxBytesPerSecond: 64_000,   // twice the real rate (32 kB/s), for bursts after a hiccup
  themeMaxMs: 30_000,          // a theme is a phrase, not a speech
  themeStreams: 3,             // at once, across everyone
  themesPerMinute: 12,         // per address
  startTimeoutMs: 5_000,
};

/**
 * Deepgram results → sentences, as stt.ts assembles them: finalized pieces build the sentence, interim text shows on top,
 * a pause (speech_final) or UtteranceEnd finishes it. flush() finishes whatever is pending (end of a theme).
 */
export function assembler(on: Pick<SttEvents, "partial" | "final">) {
  let done = "", lastSent = "";
  const flush = () => { const text = done.trim(); done = ""; lastSent = ""; if (text) on.final(text); };
  const feed = (msg: any) => {
    if (msg?.type === "UtteranceEnd") return flush();
    if (msg?.type !== "Results") return;
    const t: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
    if (msg.is_final) done += t ? " " + t : "";
    const current = (done + (msg.is_final ? "" : " " + t)).trim();
    if (current && current !== lastSent) { lastSent = current; on.partial(current); }
    if (msg.speech_final) flush();
  };
  return { feed, flush };
}

export const deepgramAvailable = () => !!process.env.DEEPGRAM_API_KEY;

export const deepgram: SttFactory = (keyterms, on) => {
  const url = "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
    "&interim_results=true&smart_format=true&endpointing=300&utterance_end_ms=1000" +
    [...new Set(keyterms.map(k => k.trim()).filter(k => k.length > 2))].slice(0, 80).map(k => `&keyterm=${encodeURIComponent(k)}`).join("");
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });
  const words = assembler(on);
  const pending: Buffer[] = [];   // audio from before the connection opened (the first ~2 s of a theme matter)
  let closing = false, onEnded: (() => void) | null = null;
  ws.on("open", () => { for (const b of pending.splice(0)) ws.send(b); if (closing) ws.send(JSON.stringify({ type: "CloseStream" })); });
  ws.on("message", d => { try { words.feed(JSON.parse(d.toString())); } catch { /* not JSON */ } });
  ws.on("unexpected-response", (_q, res) => on.error(`speech service refused the connection (${res.statusCode})`));
  ws.on("error", e => { if (!closing) on.error(`speech service: ${e.message}`); });
  ws.on("close", () => {
    clearInterval(keepAlive);
    words.flush();                 // the last words of a theme
    if (closing) onEnded?.(); else on.error("speech service closed the connection");
  });
  const keepAlive = setInterval(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" })); }, 8000);
  return {
    send: pcm => {
      if (ws.readyState === ws.OPEN) ws.send(pcm);
      else if (ws.readyState === ws.CONNECTING && pending.length < 30) pending.push(pcm);
    },
    finish: ended => {
      closing = true; onEnded = ended;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "CloseStream" })); // Deepgram sends the rest, then closes
      setTimeout(() => ws.terminate(), 3000).unref();                                  // don't wait forever
    },
    close: () => { closing = true; onEnded = null; clearInterval(keepAlive); ws.terminate(); },
  };
};

/** What the mic needs from the running talk (server.ts provides it). */
export type TalkInput = {
  token(): string | null;                                   // the current talk's token, null when no talk runs
  keyterms(): string[];                                     // the talk's trigger words, for the speech model
  hear(op: "partial" | "final", text: string): void;        // words into predict.ts
};

export function attachMic(server: Server, talk: TalkInput, opts: { stt?: SttFactory; sttAvailable?: () => boolean } = {}) {
  const stt = opts.stt ?? deepgram;
  const available = opts.sttAvailable ?? (opts.stt ? () => true : deepgramAvailable);
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes });
  let talkMic: WebSocket | null = null;
  let themeStreams = 0;
  const themeStarts = new Map<string, number[]>();   // address → start times in the last minute

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((req.url ?? "").split("?")[0] !== "/api/mic") return;   // not ours (Vite's HMR, …): leave it alone
    wss.handleUpgrade(req, socket, head, ws => handle(ws, req.socket.remoteAddress ?? ""));
  });

  function handle(ws: WebSocket, ip: string) {
    const send = (m: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    let mode: "theme" | "talk" | null = null, stream: SttStream | null = null, finals: string[] = [];
    let windowStart = Date.now(), windowBytes = 0, themeTimer: NodeJS.Timeout | undefined, counted = false;
    const fail = (code: string, message: string) => { send({ type: "mic.error", code, message }); ws.close(4003, code); };
    const startTimer = setTimeout(() => { if (!mode) fail("unauthorized", "no start message"); }, LIMITS.startTimeoutMs);

    ws.on("message", (data, isBinary) => {
      if (!mode) {
        if (isBinary) return fail("unauthorized", "send mic.start first");
        let m: any; try { m = JSON.parse(data.toString()); } catch { return fail("bad_message", "not JSON"); }
        if (m?.type !== "mic.start" || (m.mode !== "theme" && m.mode !== "talk")) return fail("bad_message", "expected mic.start");
        if (!available()) return fail("no_speech_service", "the server has no speech-to-text key (DEEPGRAM_API_KEY)");
        if (m.mode === "talk") {
          const token = talk.token();
          if (!token) return fail("not_running", "no talk is running");
          if (typeof m.token !== "string" || m.token !== token) return fail("unauthorized", "wrong talk token");
          if (talkMic && talkMic !== ws) { talkMic.send(JSON.stringify({ type: "mic.error", code: "replaced", message: "another microphone took over" })); talkMic.close(4003, "replaced"); }
          talkMic = ws;
        } else {
          const now = Date.now(), recent = (themeStarts.get(ip) ?? []).filter(t => now - t < 60_000);
          if (recent.length >= LIMITS.themesPerMinute || themeStreams >= LIMITS.themeStreams) return fail("busy", "too many people speaking at once, try again");
          themeStarts.set(ip, [...recent, now]);
          themeStreams++; counted = true;
          themeTimer = setTimeout(() => stopTheme(), LIMITS.themeMaxMs);
        }
        clearTimeout(startTimer);
        mode = m.mode;
        stream = stt(mode === "talk" ? talk.keyterms() : [], {
          partial: text => { if (mode === "talk") talk.hear("partial", text); send({ type: "mic.transcript", text, final: false }); },
          final: text => { finals.push(text); if (mode === "talk") talk.hear("final", text); send({ type: "mic.transcript", text, final: true }); },
          error: message => fail("speech_failed", message),
        });
        return send({ type: "mic.ready" });
      }
      if (!isBinary) {
        let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
        if (m?.type === "mic.stop") { if (mode === "theme") stopTheme(); else ws.close(1000, "stopped"); }
        return;
      }
      const buf = data as Buffer;
      if (mode === "talk" && !talk.token()) return fail("not_running", "the talk ended");
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; windowBytes = 0; }
      windowBytes += buf.length;
      if (buf.length % 2 || windowBytes > LIMITS.maxBytesPerSecond) return fail("bad_audio", "unexpected audio format or rate");
      stream?.send(buf);
    });

    // theme: stop listening, wait for the last words, answer with the whole phrase
    let stopping = false;
    function stopTheme() {
      if (stopping || !stream) return;
      stopping = true; clearTimeout(themeTimer);
      stream.finish(() => { send({ type: "mic.done", text: finals.join(" ").trim() }); ws.close(1000, "done"); });
    }

    ws.on("close", () => {
      clearTimeout(startTimer); clearTimeout(themeTimer);
      if (counted) themeStreams--;
      stream?.close(); stream = null;
      if (talkMic === ws) talkMic = null;
    });
    ws.on("error", () => ws.terminate());
  }

  return { close: () => { wss.clients.forEach(c => c.terminate()); wss.close(); } };
}
