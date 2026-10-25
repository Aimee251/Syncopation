import { useEffect, useRef } from 'react';

// Geometry from the Figma frames (Pos-1, Pos-2, Pos-4, Pos-5), in their 402×874 coordinates.
const W = 402;
const H = 874;
const SEAM = 437;
const LEFT = 29;
const RIGHT = 373;
const TOP = 63;
const BOTTOM = 810;
const RADIUS = 26;

// One page turn every 3 seconds: a slow turn, then a rest on the flat pages.
const TURN_MS = 1600;
const PAUSE_MS = 1400;

// The turning page is described in the top page's coordinates and then folded about the seam:
// scale 1 is flat on top, -1 is flat on the bottom. `far` is the outer edge's y and x-span.
// `blurRate` is its progressive blur on screen: px of blur per px of distance from the seam.
// `next*` is the page underneath, which comes into focus as the top page lifts away; its blur is
// progressive too, so it stays sharp where it meets the seam.
const KEYS = [
  { scale: 1, farY: TOP, farL: LEFT, farR: RIGHT, r: RADIUS, blurRate: 0, nextOpacity: 0.1, nextBlurRate: 0.05 }, // frame 1
  { scale: 1, farY: 144, farL: -101, farR: 543.5, r: 0, blurRate: 0.105, nextOpacity: 0.1, nextBlurRate: 0.05 }, // frame 2
  { scale: 0, farY: 146, farL: -101, farR: 544, r: 0, blurRate: 0.1, nextOpacity: 0.45, nextBlurRate: 0.035 }, // edge-on, between 2 and 3
  { scale: -0.72, farY: 148, farL: -101, farR: 545, r: 0, blurRate: 0.095, nextOpacity: 0.8, nextBlurRate: 0.02 }, // frame 3
  { scale: -1, farY: TOP, farL: LEFT, farR: RIGHT, r: RADIUS, blurRate: 0, nextOpacity: 1, nextBlurRate: 0 }, // frame 4, same as frame 1
];

// Colours sampled from the frames, top edge (offset 0) to the seam (offset 1).
const STOPS = [
  [0, '#f75102'],
  [0.112, '#f8650d'],
  [0.251, '#fb8420'],
  [0.393, '#fea131'],
  [0.487, '#ffb03a'],
  [0.719, '#ffb03a'],
  [0.767, '#ffb43e'],
  [0.861, '#ffcd5c'],
  [0.955, '#fee679'],
  [1, '#ffec81'],
];

// Background grid of "+" marks, measured from the frames.
const GRID_STEP = 29.67;
const GRID_START = 9;
const GRID_ARM = 9.5;
const GRID = (() => {
  const d = [];
  for (let y = GRID_START; y <= H + GRID_ARM; y += GRID_STEP) {
    for (let x = GRID_START; x <= W + GRID_ARM; x += GRID_STEP) {
      d.push(`M${x - GRID_ARM},${y}h${GRID_ARM * 2}M${x},${y - GRID_ARM}v${GRID_ARM * 2}`);
    }
  }
  return d.join('');
})();

// A progressive blur is built from copies of a page, each blurred a bit more and shown only in its
// own band between the seam and the far edge, so the bands blend into one smooth ramp.
const BLUR_LAYERS = 5;
const LAYERS = Array.from({ length: BLUR_LAYERS }, (_, k) => {
  const step = 1 / (BLUR_LAYERS - 1);
  const at = k * step;
  // Each layer fades in over the band before it, stays solid for one band, then fades out over the
  // next band while the layer above is already solid, so the stack never turns see-through.
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const stops = [
    [clamp(at - step), k === 0 ? 1 : 0],
    [at, 1],
    [clamp(at + step), 1],
    [clamp(at + 2 * step), k >= BLUR_LAYERS - 2 ? 1 : 0],
  ];
  return { k, at, stops };
});

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function pageAt(progress) {
  const span = progress * (KEYS.length - 1);
  const i = Math.min(Math.floor(span), KEYS.length - 2);
  const t = span - i;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  return Object.fromEntries(Object.keys(a).map((k) => [k, lerp(a[k], b[k], t)]));
}

/** The page outline on screen, folded about the seam by `scale`. */
function pagePath({ scale, farY, farL, farR, r }) {
  const y = (v) => SEAM + (v - SEAM) * scale;
  return [
    `M${farL},${y(farY + r)}`,
    `Q${farL},${y(farY)} ${farL + r},${y(farY)}`,
    `L${farR - r},${y(farY)}`,
    `Q${farR},${y(farY)} ${farR},${y(farY + r)}`,
    // Overlap the seam by a pixel so no hairline shows between this page and the one it meets.
    `L${RIGHT},${y(SEAM + 1)}`,
    `L${LEFT},${y(SEAM + 1)}`,
    'Z',
  ].join(' ');
}

const FLAT_PAGE = pagePath(KEYS[0]);

const BOTTOM_PAGE = [
  `M${LEFT},${SEAM}`,
  `L${RIGHT},${SEAM}`,
  `L${RIGHT},${BOTTOM - RADIUS}`,
  `Q${RIGHT},${BOTTOM} ${RIGHT - RADIUS},${BOTTOM}`,
  `L${LEFT + RADIUS},${BOTTOM}`,
  `Q${LEFT},${BOTTOM} ${LEFT},${BOTTOM - RADIUS}`,
  'Z',
].join(' ');

/**
 * A page with a blur that grows from nothing at the seam to its strongest at the far edge.
 * With `withBackdrop`, each layer also carries a blurred copy of what lies just around the page
 * (grid, labels, next page, bottom page), so things under its soft edge blur along with it.
 * With `text`, the page's writing is drawn into every layer, so it folds and blurs with the page.
 */
function ProgressiveBlur({ id, layers, fill, withBackdrop, text }) {
  return LAYERS.map(({ k, stops }) => {
    const refs = (layers[k] ??= {});
    return (
      <g key={k}>
        <defs>
          {/* Runs from the seam (offset 0) to the far edge (offset 1). */}
          <linearGradient ref={(el) => (refs.ramp = el)} id={`${id}-band-${k}`} gradientUnits="userSpaceOnUse" x1="0" y1={SEAM} x2="0" y2={TOP}>
            {stops.map(([o, v], i) => <stop key={i} offset={o} stopColor={v ? '#fff' : '#000'} />)}
          </linearGradient>
          <mask id={`${id}-mask-${k}`} maskUnits="userSpaceOnUse" x="-600" y="-600" width="1600" height="2000">
            <rect x="-600" y="-600" width="1600" height="2000" fill={`url(#${id}-band-${k})`} />
          </mask>
          <filter id={`${id}-blur-${k}`} filterUnits="userSpaceOnUse" x="-600" y="-600" width="1600" height="2000">
            <feGaussianBlur ref={(el) => (refs.blur = el)} stdDeviation="0" />
          </filter>
          {text && (
            // The writing only shows where the page is, wherever its outline has got to.
            <clipPath id={`${id}-clip-${k}`}>
              <path ref={(el) => (refs.clip = el)} d={FLAT_PAGE} />
            </clipPath>
          )}
          {withBackdrop && (
            // The page plus the reach of its blur: where the backdrop gets blurred along with it.
            <mask id={`${id}-halo-${k}`} maskUnits="userSpaceOnUse" x="-600" y="-600" width="1600" height="2000">
              <path ref={(el) => (refs.halo = el)} d={FLAT_PAGE} fill="#fff" stroke="#fff" strokeWidth="0" strokeLinejoin="round" />
            </mask>
          )}
        </defs>
        <g filter={`url(#${id}-blur-${k})`} mask={`url(#${id}-mask-${k})`}>
          {withBackdrop && (
            <g mask={`url(#${id}-halo-${k})`}>
              <use href="#backdrop" />
              <use href="#next-flat" />
              <path d={BOTTOM_PAGE} fill="url(#bottom-page)" />
              {text && <use href="#text-bottom" />}
            </g>
          )}
          <path ref={(el) => (refs.path = el)} d={FLAT_PAGE} fill={`url(#${fill})`} />
          {text && (
            // The writing on the page, folded with it. Its front reads upside down at the top of the
            // top page; once the page turns past the seam, the back shows it the right way up.
            <g clipPath={`url(#${id}-clip-${k})`}>
              <g ref={(el) => (refs.text = el)}>
                <use ref={(el) => (refs.front = el)} href="#text-top" />
                <use ref={(el) => (refs.back = el)} href="#text-back" display="none" />
              </g>
            </g>
          )}
        </g>
      </g>
    );
  });
}

function updateBlur(layers, d, p, rate) {
  // Distance on screen from the seam to the far edge; below the seam once the page has turned over.
  const reach = (SEAM - p.farY) * p.scale;
  const farScreen = SEAM - (Math.abs(reach) < 1 ? Math.sign(p.scale || 1) : reach);
  for (const { k, at } of LAYERS) {
    const layer = layers[k];
    const blur = rate * Math.abs(reach) * at;
    layer.path.setAttribute('d', d);
    layer.blur.setAttribute('stdDeviation', blur);
    layer.ramp.setAttribute('y2', farScreen);
    if (layer.halo) {
      layer.halo.setAttribute('d', d);
      layer.halo.setAttribute('stroke-width', blur * 6);
    }
    if (layer.text) {
      const back = p.scale < 0;
      layer.clip.setAttribute('d', d);
      layer.text.setAttribute('transform', `translate(0 ${SEAM}) scale(1 ${p.scale}) translate(0 ${-SEAM})`);
      // Fades as it tilts edge-on, so it thins away with the page rather than squashing flat.
      layer.text.setAttribute('opacity', Math.min(1, Math.abs(p.scale) * 1.6));
      layer.front.setAttribute('display', back ? 'none' : 'inline');
      layer.back.setAttribute('display', back ? 'inline' : 'none');
    }
  }
}

// The "Tell Your Story" screen's corners: the timer on the left, a flame on the right, and the same
// pair upside down along the top edge, each turned in place for the person across the table.
const FLAME = 'M361,822 L364.5,830 L369,826.5 L372.5,836.5 L365,844.5 L357.5,836.5 Z';

function StoryCorners({ time }) {
  const flip = (cx, cy, ty) => `translate(0 ${ty - cy}) rotate(180 ${cx} ${cy})`;
  return (
    <g className="story-corners">
      <text x="30" y="838.5">{time}</text>
      <path d={FLAME} />
      <g transform={flip(48, 833.3, 39)}>
        <text x="30" y="838.5">{time}</text>
      </g>
      <g transform={flip(365, 833.3, 39)}>
        <path d={FLAME} />
      </g>
    </g>
  );
}

function Labels({ genre, time }) {
  return (
    <g className="labels">
      <text x={LEFT} y="845">{genre}</text>
      <text x={RIGHT} y="845" textAnchor="end">{time}</text>
      {/* The same pair upside down, for the person across the table. */}
      <g transform={`rotate(180 ${W / 2} ${SEAM + 1})`}>
        <text x={LEFT} y="845">{genre}</text>
        <text x={RIGHT} y="845" textAnchor="end">{time}</text>
      </g>
    </g>
  );
}

/**
 * The page-turn loop. With `story`, it's the "Tell Your Story" screen: black grid, timer and flame
 * in the corners, and writing on the pages that folds and blurs as they turn. Otherwise it's the
 * original dark grid with the genre and timer.
 */
export default function PageTurn({ genre, time, story = false }) {
  const flapLayers = useRef([]);
  const nextLayers = useRef([]);
  const nextRef = useRef(null);
  const flapFillRef = useRef(null);
  const nextFlatRef = useRef(null);

  useEffect(() => {
    let raf;
    const start = performance.now();
    const frame = (now) => {
      if (!nextRef.current) return; // unmounted
      // Each cycle: rest on frame 1, then turn through to frame 4.
      const t = (now - start) % (PAUSE_MS + TURN_MS);
      const progress = ease(Math.max(0, t - PAUSE_MS) / TURN_MS);
      const p = pageAt(progress);
      // The turning page's colours fold over with it, so its top edge colour follows the far edge.
      flapFillRef.current.setAttribute('y1', SEAM + (TOP - SEAM) * p.scale);
      updateBlur(flapLayers.current, pagePath(p), p, p.blurRate);
      updateBlur(nextLayers.current, FLAT_PAGE, KEYS[0], p.nextBlurRate);
      nextRef.current.setAttribute('opacity', p.nextOpacity);
      nextFlatRef.current.setAttribute('opacity', p.nextOpacity);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg className="pages" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="top-page" gradientUnits="userSpaceOnUse" x1="0" y1={TOP} x2="0" y2={SEAM}>
          {STOPS.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
        </linearGradient>
        <linearGradient ref={flapFillRef} id="flap-page" gradientUnits="userSpaceOnUse" x1="0" y1={TOP} x2="0" y2={SEAM}>
          {STOPS.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
        </linearGradient>
        <linearGradient id="bottom-page" gradientUnits="userSpaceOnUse" x1="0" y1={BOTTOM} x2="0" y2={SEAM}>
          {STOPS.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
        </linearGradient>
        {/* The writing on the pages: right way up on the bottom page, upside down at the top of the
            top page, and mirrored on the turning page's back so it lands the right way up. */}
        {story && (
          <>
            <text id="text-bottom" className="page-text" x={W / 2} y="764" textAnchor="middle">
              Tell Your Story
            </text>
            <use id="text-top" href="#text-bottom" transform={`rotate(180 ${W / 2} ${SEAM})`} />
            <use id="text-back" href="#text-bottom" transform={`translate(0 ${H}) scale(1 -1)`} />
          </>
        )}
        {/* Everything behind the pages. */}
        <g id="backdrop">
          {story ? (
            <>
              <rect x="-600" y="-600" width="1600" height="2000" fill="#000" />
              <path d={GRID} stroke="#262626" strokeWidth="1" fill="none" />
              <StoryCorners time={time} />
            </>
          ) : (
            <>
              <rect x="-600" y="-600" width="1600" height="2000" fill="#171717" />
              <path d={GRID} stroke="#292929" strokeWidth="1" fill="none" />
              <Labels genre={genre} time={time} />
            </>
          )}
        </g>
        {/* A plain copy of the next page for the turning page's backdrop; it gets blurred there anyway. */}
        <g ref={nextFlatRef} id="next-flat" opacity={KEYS[0].nextOpacity}>
          <path d={FLAT_PAGE} fill="url(#top-page)" />
          {story && <use href="#text-top" />}
        </g>
      </defs>

      <use href="#backdrop" />
      <g ref={nextRef} opacity={KEYS[0].nextOpacity}>
        <ProgressiveBlur id="next" layers={nextLayers.current} fill="top-page" text={story} />
      </g>
      <path d={BOTTOM_PAGE} fill="url(#bottom-page)" />
      {story && <use href="#text-bottom" />}
      <ProgressiveBlur id="flap" layers={flapLayers.current} fill="flap-page" withBackdrop text={story} />
    </svg>
  );
}
