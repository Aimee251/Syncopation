import { useRef } from 'react';

// How far the line has to travel: from the top of the wheel round to the arrow underneath it.
const TURN_DEGREES = 180;

/**
 * The big black wheel. Turn it with a finger to bring its white line round to the arrow;
 * `onProgress` reports 0–1 along the way and `onDone` fires when the line reaches the arrow.
 * With `leaving`, it empties to a thin ring, counts down 3, 2, 1 inside it, then the ring undraws.
 */
export default function Wheel({ done, leaving, onProgress, onDone }) {
  const spinRef = useRef(null);
  const drag = useRef(null);
  const rotation = useRef(0);

  const angleAt = (e, box) =>
    (Math.atan2(e.clientY - (box.top + box.height / 2), e.clientX - (box.left + box.width / 2)) * 180) / Math.PI;

  const down = (e) => {
    if (done) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const box = e.currentTarget.getBoundingClientRect();
    drag.current = { box, last: angleAt(e, box) };
  };

  const move = (e) => {
    const d = drag.current;
    if (!d || done) return;
    const angle = angleAt(e, d.box);
    // Shortest way round from the last angle, so crossing ±180° doesn't jump.
    let delta = angle - d.last;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    d.last = angle;

    // Either direction works; it's how far round the line has come that counts.
    const next = Math.max(-TURN_DEGREES, Math.min(TURN_DEGREES, rotation.current + delta));
    rotation.current = next;
    spinRef.current.style.rotate = `${next}deg`;
    const progress = Math.abs(next) / TURN_DEGREES;
    onProgress(progress);
    if (progress >= 1) {
      drag.current = null;
      navigator.vibrate?.(30);
      onDone();
    }
  };

  const up = () => {
    drag.current = null;
  };

  return (
    <>
      <div
        className={`wheel ${leaving ? 'leaving' : ''}`}
        role="slider"
        aria-label="Turn the wheel to the arrow"
        aria-valuemin={0}
        aria-valuemax={100}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <div className="wheel-disc" />
        {/* The thin ring left behind at the end, which then undraws itself. */}
        <svg className="wheel-ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="49.75" pathLength="100" />
        </svg>
        <div ref={spinRef} className="wheel-spin">
          <span className="wheel-line" />
        </div>
        <span className="wheel-dot" />
        {leaving && (
          <div className="countdown" aria-live="polite">
            {[3, 2, 1].map((n) => (
              <span key={n} className={`count count-${n}`}>
                {n}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="wheel-extras">
        <span className="wheel-arrow" aria-hidden="true" />
        <p className="wheel-label">Unwind the Narrative</p>
      </div>
    </>
  );
}
