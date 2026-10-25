// @ts-check
// mic.js — the host phone's microphone → the room server (/room/mic) → speech-to-text → the talk.
// Echo cancellation, noise suppression and auto gain are requested from the browser. Echo cancellation only removes
// this phone's own output; other phones' sound can still reach the mic, so keep the phone close to your mouth.

import { PROTOCOL_VERSION } from "/room/protocol.js";

export const MIC_ERRORS = {
  insecure: "The microphone only works on a secure (https://) page. Open this site through its https address.",
  unsupported: "This browser can't stream the microphone. Try an up-to-date Chrome or Safari.",
  denied: "Microphone permission was refused. Allow it in the browser's site settings, then try again.",
  no_device: "No microphone found.",
  unauthorized: "Only the host can use the microphone.",
  not_running: "Start the talk first.",
  no_speech_service: "The server isn't set up for speech (it needs a DEEPGRAM_API_KEY).",
  speech_failed: "The speech service stopped. Turn the microphone on again.",
  bad_audio: "The audio stream was rejected. Turn the microphone on again.",
  replaced: "The microphone was turned on somewhere else.",
  connection: "Lost the connection to the server.",
};

export class MicStream {
  /** @param {{ onState: (s: "off" | "starting" | "live") => void, onLevel: (rms: number) => void, onTranscript: (text: string, final: boolean) => void, onError: (code: string) => void }} cb */
  constructor(cb) { this.cb = cb; this.state = "off"; /** @type {WebSocket | null} */ this.ws = null; }

  /** Call from a tap. @param {string} token the host token */
  async start(token) {
    if (this.state !== "off") return;
    if (!window.isSecureContext) return this.fail("insecure");
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) return this.fail("unsupported");
    this.set("starting");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      const name = /** @type {any} */ (e)?.name;
      return this.fail(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" ? "no_device" : "unsupported");
    }
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    const ctx = this.ctx = new AC();
    await ctx.audioWorklet.addModule("/room/mic-worklet.js");
    const src = ctx.createMediaStreamSource(this.stream);
    const node = this.node = new AudioWorkletNode(ctx, "mic-pcm", { processorOptions: { srcRate: ctx.sampleRate } });
    const sink = ctx.createGain(); sink.gain.value = 0;          // keeps the graph running; nothing is played back
    src.connect(node); node.connect(sink); sink.connect(ctx.destination);
    if (ctx.state !== "running") await ctx.resume();

    const ws = this.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/room/mic`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => ws.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "mic.auth", token }));
    ws.onmessage = e => {
      if (typeof e.data !== "string") return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "mic.ready") this.set("live");
      else if (m.type === "mic.transcript" && typeof m.text === "string") this.cb.onTranscript(m.text, !!m.final);
      else if (m.type === "mic.error") this.fail(String(m.code));
    };
    ws.onclose = () => { if (this.state !== "off") this.fail("connection"); };
    node.port.onmessage = e => {
      this.cb.onLevel(e.data.rms);
      if (this.state === "live" && ws.readyState === WebSocket.OPEN) ws.send(e.data.pcm);
    };
  }

  stop() {
    const ws = this.ws; this.ws = null;
    this.set("off");
    if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "mic.stop" })); ws.close(); }
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    this.node?.disconnect(); this.node = null;
    this.ctx?.close().catch(() => { }); this.ctx = null;
    this.cb.onLevel(0);
  }

  /** @param {string} code */
  fail(code) { this.stop(); this.cb.onError(code); }
  /** @param {"off" | "starting" | "live"} s */
  set(s) { this.state = s; this.cb.onState(s); }
}
