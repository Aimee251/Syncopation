// The browser's microphone, streamed to the backend (server.ts → micServer.ts) for speech-to-text, so the talk hears
// whoever holds this phone — not the laptop running the backend.
//
// The mic is opened once, on the hold-to-speak press (a tap: phones only start audio from one), and kept open through
// the talk; closeMic() turns it off. Echo cancellation only removes this phone's own sound, so keep it close to your mouth.

import { micUrl } from './backend.js';

export const MIC_MESSAGES = {
  insecure: 'The microphone needs a secure (https) page.',
  unsupported: "This browser can't use the microphone. Try Safari or Chrome.",
  denied: 'Microphone blocked. Allow it for this site in your browser settings.',
  no_device: 'No microphone found.',
  no_speech_service: "The backend can't transcribe speech yet (it needs a DEEPGRAM_API_KEY).",
  not_running: 'The talk has stopped.',
  busy: 'Too many people speaking at once. Try again.',
  replaced: 'The microphone was turned on somewhere else.',
  speech_failed: 'Speech recognition stopped.',
  bad_audio: 'The microphone stream was rejected.',
  connection: "Can't reach the backend. Is the tunnel running?",
};

export class MicError extends Error {
  constructor(code) { super(MIC_MESSAGES[code] || `Microphone error (${code}).`); this.code = code; }
}

export const micSupported = () =>
  typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && !!window.AudioWorkletNode;

// ---- the one shared capture: getUserMedia → worklet (16 kHz PCM chunks) → subscribers ----
let shared = null;

/** Opens the microphone (asks permission the first time). Call it from a tap. */
export function openMic() {
  if (shared) return shared.ready;
  if (!window.isSecureContext) return Promise.reject(new MicError('insecure'));
  if (!micSupported()) return Promise.reject(new MicError('unsupported'));
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();                    // created inside the tap, so it is allowed to run
  const s = { ctx, stream: null, node: null, subs: new Set() };
  shared = s;
  s.ready = (async () => {
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      throw new MicError(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'denied' : e?.name === 'NotFoundError' ? 'no_device' : 'unsupported');
    }
    await ctx.audioWorklet.addModule(new URL('/mic-worklet.js', window.location.origin).href);
    const src = ctx.createMediaStreamSource(s.stream);
    s.node = new AudioWorkletNode(ctx, 'mic-pcm', { processorOptions: { srcRate: ctx.sampleRate } });
    const sink = ctx.createGain(); // keeps the graph running; nothing is played back
    sink.gain.value = 0;
    src.connect(s.node); s.node.connect(sink); sink.connect(ctx.destination);
    s.node.port.onmessage = (e) => s.subs.forEach((fn) => fn(e.data));
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  })();
  s.ready.catch(() => { if (shared === s) closeMic(); });
  return s.ready;
}

/** Turns the microphone off (the browser's recording indicator goes away). */
export function closeMic() {
  const s = shared;
  shared = null;
  if (!s) return;
  s.subs.clear();
  s.stream?.getTracks().forEach((t) => t.stop());
  s.node?.disconnect();
  s.ctx.close().catch(() => {});
}

/**
 * Streams the open microphone to the backend.
 *   mode 'theme': the held phrase; stop() resolves with what was said
 *   mode 'talk' : the talk's words, until close(); needs the token from startTalk()
 * `ready` rejects with a MicError (permission, no speech service, …).
 */
export function streamMic({ mode, token, onTranscript, onLevel }) {
  let ws = null, live = false, closed = false;
  let onError = null;
  const early = [];                        // audio from before the backend said ready (the first words matter)
  const finals = [];
  let interim = '';
  let resolveDone = null;
  const done = new Promise((r) => { resolveDone = r; });
  let fail = () => {};
  const ready = new Promise((resolve, reject) => {
    fail = (code) => { reject(new MicError(code)); finish(); };
    openMic().then(() => {
      if (closed) return;
      shared.subs.add(onChunk);
      ws = new WebSocket(micUrl());
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(JSON.stringify({ type: 'mic.start', mode, token }));
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'mic.ready') { live = true; early.splice(0).forEach((b) => ws.send(b)); resolve(); }
        else if (m.type === 'mic.transcript') {
          if (m.final) { finals.push(m.text); interim = ''; } else interim = m.text;
          onTranscript?.(m.text, m.final);
        } else if (m.type === 'mic.done') finish(m.text);
        else if (m.type === 'mic.error') { onError?.(new MicError(m.code)); fail(m.code); }
      };
      ws.onclose = () => { if (!live) fail('connection'); else { onError?.(closed ? null : new MicError('connection')); finish(); } };
    }, (e) => { reject(e); finish(); });
  });
  ready.catch(() => {});

  function onChunk({ pcm, rms }) {
    onLevel?.(rms);
    if (live && ws.readyState === WebSocket.OPEN) ws.send(pcm);
    else if (!live && early.length < 30) early.push(pcm);
  }
  function finish(text) {
    if (closed) return;
    closed = true;
    shared?.subs.delete(onChunk);
    resolveDone((text ?? [...finals, interim].filter(Boolean).join(' ')).trim());
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  }

  return {
    ready,
    /** talk mode: called if the stream dies later (null when closed on purpose) */
    set onError(fn) { onError = fn; },
    /** theme: stop listening and get the phrase (waits briefly for the last words) */
    stop() {
      if (!closed && live && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mic.stop' }));
        setTimeout(() => finish(), 3500);
      } else finish();
      return done;
    },
    close() { finish(); },
  };
}
