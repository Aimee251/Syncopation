import { useEffect, useRef, useState } from 'react';
import PageTurn from './PageTurn.jsx';

// The genre shown on screen; set it with ?genre=Ambient in the URL.
const GENRE = (new URLSearchParams(window.location.search).get('genre') || 'Genre').toUpperCase();

const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export default function OldApp() {
  const [startedAt, setStartedAt] = useState(null);
  const [seconds, setSeconds] = useState(0);
  const wakeLock = useRef(null);
  const playing = startedAt !== null;

  // Keep the screen awake while it plays (needs HTTPS or localhost; ignored elsewhere).
  useEffect(() => {
    if (!playing) return;
    navigator.wakeLock?.request('screen').then((lock) => (wakeLock.current = lock)).catch(() => {});
    return () => {
      wakeLock.current?.release().catch(() => {});
      wakeLock.current = null;
    };
  }, [playing]);

  // Time spent on the page-turning screen.
  useEffect(() => {
    if (!playing) return;
    const tick = () => setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [playing, startedAt]);

  const go = () => {
    navigator.vibrate?.(30);
    setSeconds(0);
    setStartedAt(Date.now());
  };

  return (
    <main className="stage">
      {playing ? (
        <div className="screen" onClick={() => setStartedAt(null)}>
          <PageTurn genre={GENRE} time={formatTime(seconds)} />
        </div>
      ) : (
        <button className="go" onClick={go}>
          Go
        </button>
      )}
    </main>
  );
}
