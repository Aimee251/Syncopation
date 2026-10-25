import { useEffect, useRef } from 'react';

// Rendered small and stretched to fill, so the browser's smoothing turns it into a soft gradient.
const COLS = 48;
const ROWS = 96;

// Top of the screen down to where it fades into the off-white page, from the mockup.
const STOPS = [
  [0, [255, 92, 8]],
  [0.12, [255, 140, 30]],
  [0.24, [255, 200, 60]],
  [0.3, [255, 222, 72]],
  [0.48, [254, 238, 160]],
  [0.68, [253, 248, 228]],
  [0.85, [249, 249, 249]],
  [1, [249, 249, 249]],
];

function colourAt(v) {
  if (v <= 0) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    const [b, cb] = STOPS[i];
    if (v <= b) {
      const [a, ca] = STOPS[i - 1];
      const t = (v - a) / (b - a);
      return [0, 1, 2].map((k) => ca[k] + (cb[k] - ca[k]) * t);
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/** The flowing gradient across the top of the screen: its colour bands ripple like slow waves. */
export default function WaveGradient() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    canvas.width = COLS;
    canvas.height = ROWS;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(COLS, ROWS);
    let raf;

    const frame = (now) => {
      if (!canvasRef.current) return; // unmounted
      const t = now / 1000;
      for (let y = 0; y < ROWS; y++) {
        const v = y / (ROWS - 1);
        for (let x = 0; x < COLS; x++) {
          const u = x / (COLS - 1);
          // Two overlapping swells drifting in opposite directions, stronger lower down
          // where the colours are spread out, gentler near the top edge.
          const swell =
            0.045 * Math.sin(u * 5.5 + t * 0.9 + v * 2.2) +
            0.025 * Math.sin(u * 11 - t * 1.4 + v * 4.5);
          const c = colourAt(v + swell * (0.35 + v));
          const i = (y * COLS + x) * 4;
          image.data[i] = c[0];
          image.data[i + 1] = c[1];
          image.data[i + 2] = c[2];
          image.data[i + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className="wave" aria-hidden="true" />;
}
