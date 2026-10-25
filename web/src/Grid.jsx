// The background grid of "+" marks from the Figma frames, in the same 402×874 frame as everything else.
const W = 402;
const H = 874;
const STEP = 29.67;
const ARM = 9.5;

// Marks run well past the frame so they still fill the screen when it's letterboxed.
const PATH = (() => {
  const d = [];
  const first = 9 - STEP * 20;
  for (let y = first; y <= H * 2; y += STEP) {
    for (let x = first; x <= W * 2; x += STEP) {
      d.push(`M${(x - ARM).toFixed(2)},${y.toFixed(2)}h${ARM * 2}M${x.toFixed(2)},${(y - ARM).toFixed(2)}v${ARM * 2}`);
    }
  }
  return d.join('');
})();

export default function Grid() {
  return (
    <svg className="grid" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <path d={PATH} stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}
