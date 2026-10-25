// room/deepgram.ts — streaming speech-to-text for a host phone's microphone, on the server (the API key never leaves it).
// Same model and settings as stt.ts's local streaming: nova-3, interim results, 300 ms endpointing, the talk's
// trigger words as key terms. Audio in: 16 kHz mono 16-bit PCM. Out: the sentence so far, and each finished sentence.

import { WebSocket } from "ws";

export type SttEvents = { partial(text: string): void; final(text: string): void; error(message: string): void };
export interface SttStream { send(pcm: Buffer): void; close(): void }
export type SttFactory = (keyterms: string[], on: SttEvents) => SttStream;

/**
 * Deepgram results → sentences, exactly as stt.ts assembles them: finalized pieces build up the sentence, interim text
 * is shown on top, and a pause (speech_final) or UtteranceEnd finishes it.
 */
export function assembler(on: Pick<SttEvents, "partial" | "final">) {
  let done = "", lastSent = "";
  const flush = () => { const text = done.trim(); done = ""; lastSent = ""; if (text) on.final(text); };
  return (msg: any) => {
    if (msg?.type === "UtteranceEnd") return flush();
    if (msg?.type !== "Results") return;
    const t: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
    if (msg.is_final) done += t ? " " + t : "";
    const current = (done + (msg.is_final ? "" : " " + t)).trim();
    if (current && current !== lastSent) { lastSent = current; on.partial(current); }
    if (msg.speech_final) flush();
  };
}

export const deepgramAvailable = () => !!process.env.DEEPGRAM_API_KEY;

export const deepgram: SttFactory = (keyterms, on) => {
  const url = "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
    "&interim_results=true&smart_format=true&endpointing=300&utterance_end_ms=1000" +
    [...new Set(keyterms.map(k => k.trim()).filter(k => k.length > 2))].slice(0, 80).map(k => `&keyterm=${encodeURIComponent(k)}`).join("");
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } });
  const handle = assembler(on);
  const pending: Buffer[] = [];   // audio that arrived before the connection opened (bounded: ~2 s)
  let closed = false;
  ws.on("open", () => { for (const b of pending.splice(0)) ws.send(b); });
  ws.on("message", d => { try { handle(JSON.parse(d.toString())); } catch { /* not JSON */ } });
  ws.on("unexpected-response", (_req, res) => on.error(`speech service refused the connection (${res.statusCode})`));
  ws.on("error", e => { if (!closed) on.error(`speech service: ${e.message}`); });
  ws.on("close", () => { clearInterval(keepAlive); if (!closed) on.error("speech service closed the connection"); });
  const keepAlive = setInterval(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" })); }, 8000);
  return {
    send: pcm => {
      if (ws.readyState === ws.OPEN) ws.send(pcm);
      else if (ws.readyState === ws.CONNECTING && pending.length < 20) pending.push(pcm);
    },
    close: () => {
      closed = true; clearInterval(keepAlive);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
      setTimeout(() => ws.terminate(), 500).unref();
    },
  };
};
