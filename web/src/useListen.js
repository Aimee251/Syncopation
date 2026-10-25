import { useCallback, useRef } from 'react';
import { micSupported, openMic, streamMic, MIC_MESSAGES } from './mic.js';

const SpeechRecognition = typeof window !== 'undefined'
  ? window.SpeechRecognition || window.webkitSpeechRecognition
  : undefined;

// The backend transcribes the phone's own microphone (mic.js); the browser's built-in recognition is only a fallback
// for a backend without a speech key. Firefox and many in-app browsers have no built-in recognition at all.
export const listenSupported = micSupported() || Boolean(SpeechRecognition);

/**
 * Push-to-talk: `start()` begins listening (call it from the press), `stop()` resolves with everything heard ('' if
 * nothing was). `lastError()` says why nothing was heard, when there's a reason worth showing.
 */
export function useListen() {
  const session = useRef(null);
  const lastError = useRef(null);

  const start = useCallback(() => {
    session.current?.cancel?.();
    lastError.current = null;
    const s = { kind: 'server', stream: null, rec: null, opened: false, cancel: null };
    session.current = s;
    // open the mic inside the press: phones only allow audio to start from a tap
    openMic().then(() => { s.opened = true; }, () => {});
    s.stream = streamMic({ mode: 'theme' });
    s.cancel = () => s.stream.close();
    s.stream.ready.catch((e) => {
      if (session.current !== s) return;
      if (e.code === 'no_speech_service' && SpeechRecognition) startBuiltIn(s); // backend can't transcribe: the browser's own
      else lastError.current = e.message;
    });
  }, []);

  const stop = useCallback(() => {
    const s = session.current;
    if (!s) return Promise.resolve('');
    session.current = null;
    if (s.kind === 'builtin') return stopBuiltIn(s).then((text) => { if (!text && s.error) lastError.current = s.error; return text; });
    return s.stream.stop().then((text) => {
      // first press: the permission prompt took the hold; the mic is on now
      if (!text && !lastError.current && !s.opened) lastError.current = 'Microphone on. Hold and speak again.';
      return text;
    });
  }, []);

  return { start, stop, lastError: () => lastError.current };
}

// ---- fallback: the browser's built-in speech recognition ----
function startBuiltIn(s) {
  s.kind = 'builtin';
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  Object.assign(s, { rec, finals: [], interim: '', ended: false, onEnd: null });
  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) s.finals.push(result[0].transcript.trim());
      else interim += result[0].transcript;
    }
    s.interim = interim.trim();
  };
  rec.onend = () => { s.ended = true; s.onEnd?.(); };
  rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') s.error = MIC_MESSAGES.denied; };
  s.cancel = () => rec.abort();
  try { rec.start(); } catch { s.ended = true; }
}

function stopBuiltIn(s) {
  const text = () => [...s.finals, s.interim].filter(Boolean).join(' ');
  return new Promise((resolve) => {
    if (s.ended) return resolve(text());
    // The final result usually lands just after stop(); don't wait forever for it.
    const timer = setTimeout(() => resolve(text()), 1500);
    s.onEnd = () => { clearTimeout(timer); resolve(text()); };
    s.rec.stop();
  });
}
