import { useCallback, useRef } from 'react';

const SpeechRecognition = typeof window !== 'undefined'
  ? window.SpeechRecognition || window.webkitSpeechRecognition
  : undefined;

export const listenSupported = Boolean(SpeechRecognition);

/**
 * Push-to-talk speech recognition: `start()` begins listening, `stop()` resolves with everything
 * heard (or '' if nothing was), once the browser has delivered its last result.
 */
export function useListen() {
  const session = useRef(null);

  const start = useCallback(() => {
    if (!SpeechRecognition) return;
    session.current?.rec.abort();

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    const s = { rec, finals: [], interim: '', ended: false, onEnd: null };
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) s.finals.push(result[0].transcript.trim());
        else interim += result[0].transcript;
      }
      s.interim = interim.trim();
    };
    rec.onend = () => {
      s.ended = true;
      s.onEnd?.();
    };
    rec.onerror = () => {}; // 'no-speech' and friends just end the session with nothing heard

    session.current = s;
    try {
      rec.start();
    } catch {
      s.ended = true;
    }
  }, []);

  const stop = useCallback(() => {
    const s = session.current;
    if (!s) return Promise.resolve('');
    session.current = null;
    const text = () => [...s.finals, s.interim].filter(Boolean).join(' ');
    return new Promise((resolve) => {
      if (s.ended) return resolve(text());
      // The final result usually lands just after stop(); don't wait forever for it.
      const timer = setTimeout(() => resolve(text()), 1500);
      s.onEnd = () => {
        clearTimeout(timer);
        resolve(text());
      };
      s.rec.stop();
    });
  }, []);

  return { start, stop };
}
