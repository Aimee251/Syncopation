import { useEffect, useState } from 'react';

// The hand-drawn fire, played frame by frame. Every frame is stacked and only the current one is
// shown, so there's never a blank flash while one loads.
// Bump the version when the frame files change, so phones don't keep showing cached old ones.
const FRAMES = [1, 2, 3, 4].map((n) => `/fire/${n}.png?v=2`);
const FRAME_MS = 220;

export default function Fire({ className }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className={className} aria-hidden="true">
      {FRAMES.map((src, i) => (
        <img key={src} src={src} alt="" draggable="false" style={{ opacity: i === frame ? 1 : 0 }} />
      ))}
    </div>
  );
}
