// room/mic.ts — the host phone's microphone as the talk's input (WebSocket /room/mic).
//
//   phone → { protocolVersion, type: "mic.auth", token: <host token> }      first message, text
//   phone → binary frames: 16 kHz mono 16-bit PCM, ~100 ms each
//   server → mic.ready | mic.transcript { text, final } | mic.error { code, message }
//
// Only the room's host can stream (member tokens are refused), only while its talk is running, one microphone per room
// (a newer one replaces the older). Audio goes to the speech service and is not stored. Audience phones never send audio.

import type { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { RoomManager } from "./rooms";
import type { TalkManager } from "./talks";
import { deepgram, deepgramAvailable, type SttFactory, type SttStream } from "./deepgram";

export const MIC_LIMITS = {
  maxFrameBytes: 32_000,        // 1 s of audio in one frame is already generous
  maxBytesPerSecond: 64_000,    // twice the real rate (32 kB/s), for bursts after a hiccup
  authTimeoutMs: 5_000,
};

type MicError = "unauthorized" | "not_running" | "no_speech_service" | "bad_audio" | "speech_failed" | "replaced";

export class MicHub {
  private active = new Map<string, WebSocket>();   // roomId → the one mic socket
  private stt: SttFactory;
  private sttAvailable: () => boolean;

  constructor(private manager: RoomManager, private talks: TalkManager, opts: { stt?: SttFactory; sttAvailable?: () => boolean } = {}) {
    this.stt = opts.stt ?? deepgram;
    this.sttAvailable = opts.sttAvailable ?? (opts.stt ? () => true : deepgramAvailable);
  }

  attach(ws: WebSocket) {
    const send = (m: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...m })); };
    const fail = (code: MicError, message: string) => { send({ type: "mic.error", code, message }); ws.close(4003, code); };
    let roomId: string | null = null, stt: SttStream | null = null;
    let windowStart = Date.now(), windowBytes = 0;
    const authTimer = setTimeout(() => { if (!roomId) fail("unauthorized", "no credentials"); }, MIC_LIMITS.authTimeoutMs);

    ws.on("message", (data, isBinary) => {
      if (!roomId) {
        // first message: who is this?
        if (isBinary) return fail("unauthorized", "authenticate first");
        let msg: any; try { msg = JSON.parse(data.toString()); } catch { return fail("unauthorized", "bad credentials"); }
        const id = msg?.protocolVersion === PROTOCOL_VERSION && msg.type === "mic.auth" && typeof msg.token === "string" && msg.token.length <= 100 ? this.manager.roomForHostToken(msg.token) : null;
        if (!id) return fail("unauthorized", "only the host can use the microphone");
        if (this.talks.phase(id) !== "running") return fail("not_running", "start the talk first");
        if (!this.sttAvailable()) return fail("no_speech_service", "the server has no speech-to-text key (DEEPGRAM_API_KEY)");
        clearTimeout(authTimer);
        roomId = id;
        const older = this.active.get(id);
        if (older && older !== ws) { older.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "mic.error", code: "replaced", message: "another microphone took over" })); older.close(4003, "replaced"); }
        this.active.set(id, ws);
        stt = this.stt(this.talks.keytermsFor(id), {
          partial: text => { this.talks.hear(id, "partial", text); send({ type: "mic.transcript", text, final: false }); },
          final: text => { this.talks.hear(id, "final", text); send({ type: "mic.transcript", text, final: true }); },
          error: message => fail("speech_failed", message),
        });
        return send({ type: "mic.ready" });
      }
      if (!isBinary) { // the only text after auth: stop
        try { if (JSON.parse(data.toString())?.type === "mic.stop") ws.close(1000, "stopped"); } catch { }
        return;
      }
      const buf = data as Buffer;
      if (this.talks.phase(roomId) !== "running") return fail("not_running", "the talk ended");
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; windowBytes = 0; }
      windowBytes += buf.length;
      if (buf.length > MIC_LIMITS.maxFrameBytes || buf.length % 2 || windowBytes > MIC_LIMITS.maxBytesPerSecond) return fail("bad_audio", "unexpected audio format or rate");
      stt?.send(buf);
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      stt?.close(); stt = null;
      if (roomId && this.active.get(roomId) === ws) this.active.delete(roomId);
    });
    ws.on("error", () => ws.terminate());
  }

  /** Room or talk over: drop its microphone. */
  stop(roomId: string) { this.active.get(roomId)?.close(1000, "talk ended"); this.active.delete(roomId); }
}
