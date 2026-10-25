import { useEffect, useRef } from 'react';

// The strike of fire down the middle of the opening screen (Figma "fyfj", 82:1832), drawn in the
// same 402×874 frame as everything else. It's rendered small and stretched, then blurred in CSS,
// which is what gives it its soft edges.
const W = 402;
const H = 874;
const RES = 0.2; // canvas pixels per mockup px

// Its half-width down the screen: widest behind the logo, narrowing towards the button.
const WIDTH = [
  [0, 112],
  [300, 106],
  [500, 96],
  [650, 86],
  [780, 68],
  [860, 52],
];
// Its colour down the screen: deep orange at the top, through orange, to yellow fading out at the bottom.
const COLOURS = [
  [0, 'rgba(255, 94, 8, 1)'],
  [0.25, 'rgba(255, 106, 12, 1)'],
  [0.4, 'rgba(255, 138, 24, 1)'],
  [0.6, 'rgba(255, 164, 36, 1)'],
  [0.75, 'rgba(255, 190, 46, 1)'],
  [0.86, 'rgba(255, 215, 90, 0.85)'],
  [0.96, 'rgba(255, 232, 150, 0)'],
];

function halfWidth(y) {
  for (let i = 1; i < WIDTH.length; i++) {
    const [y1, w1] = WIDTH[i];
    if (y <= y1) {
      const [y0, w0] = WIDTH[i - 1];
      return w0 + ((w1 - w0) * (y - y0)) / (y1 - y0);
    }
  }
  return WIDTH[WIDTH.length - 1][1];
}

export default function Strike({ className }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let raf;

    const frame = (now) => {
      if (!canvasRef.current) return; // unmounted
      const t = now / 1000;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const cw = Math.max(1, Math.round(w * RES));
      const ch = Math.max(1, Math.round(h * RES));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      // Fit the mockup frame to the screen the same way as the rest of the app.
      const u = Math.min(w / W, h / H);
      ctx.setTransform(RES * u, 0, 0, RES * u, RES * (w - W * u) / 2, RES * (h - H * u) / 2);
      ctx.clearRect(-W, -H, W * 3, H * 3);

      const fill = ctx.createLinearGradient(0, 0, 0, H);
      for (const [o, c] of COLOURS) fill.addColorStop(o, c);
      ctx.fillStyle = fill;

      // Each edge sways and ripples on its own, with waves travelling upward like rising heat.
      const left = [];
      const right = [];
      for (let y = -40; y <= H + 40; y += 12) {
        const sway = 7 * Math.sin(y * 0.011 + t * 1.5) + 3 * Math.sin(y * 0.029 + t * 2.4);
        const breathe = 1 + 0.06 * Math.sin(y * 0.018 + t * 2.1);
        const hw = halfWidth(y) * breathe;
        const flickerL = 5 * Math.sin(y * 0.045 + t * 3.1);
        const flickerR = 5 * Math.sin(y * 0.041 + t * 2.7 + 1.7);
        left.push([W / 2 + sway - hw + flickerL, y]);
        right.push([W / 2 + sway + hw + flickerR, y]);
      }
      ctx.beginPath();
      left.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(...right[i]);
      ctx.closePath();
      ctx.fill();

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
