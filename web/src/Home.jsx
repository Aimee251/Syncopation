import { useEffect, useRef, useState } from 'react';
import Grid from './Grid.jsx';
import PageTurn from './PageTurn.jsx';
import WaveGradient from './WaveGradient.jsx';
import Wheel from './Wheel.jsx';
import { listenSupported, useListen } from './useListen.js';
import { startSession, startTalk, stopTalk, whenReady } from './backend.js';
import { closeMic, streamMic } from './mic.js';

// Layout from the mockup, in its 402×874 px.
const BUTTON = { x: 201, y: 717 };
const BUBBLE = { x: 201, y: 150, w: 283, h: 102 };
const FLIGHT_MS = 1500;
// The bubble starts forming before the orb arrives, so one melts into the other.
const FORM_AT = 0.68;

// When the orb reaches the bubble's spot, as a share of FLIGHT_MS. It travels there on one smooth
// ease-in-out curve, so it glides up and settles instead of landing with a thud.
const ARRIVE = 0.78;

// The glow's shape along the way: it stretches upward off the button, pinches into a small rounded
// rectangle, opens out into the pill, then swells, blurs and dissolves into the bubble forming
// underneath it. Sizes in mockup px; each step eases in and out of the next.
const SHAPE = [
  { offset: 0, w: 150, h: 150, r: 75, blur: 10, opacity: 1 },
  { offset: 0.18, w: 130, h: 230, r: 52, blur: 12, opacity: 1 },
  // A small version of the bubble: a rounded rectangle in its proportions, not a circle.
  { offset: 0.42, w: 150, h: 58, r: 26, blur: 8, opacity: 1 },
  { offset: ARRIVE, w: BUBBLE.w, h: BUBBLE.h, r: 51, blur: 8, opacity: 1 },
  { offset: 1, w: BUBBLE.w + 24, h: BUBBLE.h + 16, r: 59, blur: 18, opacity: 0 },
];

// Once the words are in, how long they stay up before fading out for the wheel.
const READ_MS = 1800;
// Matches .stage-wheel .bubble in styles.css.
const BUBBLE_OUT_MS = 700;
// After the line reaches the arrow: a short beat, then the wheel empties to a ring with the glowing
// orb inside until the backend has the first sounds (at least LOADER_MIN_MS so it never just flickers),
// then the ring undraws (RING_OUT_MS, matches .wheel-ring in styles.css) and the background scales
// down into the pages.
const DONE_PAUSE_MS = 250;
const LOADER_MIN_MS = 1500;
const RING_OUT_MS = 700;
const SHRINK_MS = 1200;
// Talk length sent to the backend (it paces the sound plan). TODO: take it from a time picker.
const TALK_MINUTES = 3;
// After an error, how long the message stays in the ring before going back home.
const ERROR_MS = 3500;

// The pages, in mockup px: the background scales down to exactly this.
const PAGES = { w: 344, h: 747 };

const NOTHING_HEARD = listenSupported
  ? "Didn't catch that. Hold and speak."
  : "This browser can't listen. Try Safari or Chrome.";

export default function Home() {
  const [holding, setHolding] = useState(false);
  const [flying, setFlying] = useState(false);
  const [bubble, setBubble] = useState(null);
  // 'home' (hold to speak) → 'wheel' (turn it to the arrow) → 'launch' (the ring undraws) →
  // 'shrink' (the background scales down into the pages) → 'turning' (the page-turn loop),
  // then 'closing' on the way back to home.
  const [stage, setStage] = useState('home');
  // The wheel's line has reached the arrow.
  const [done, setDone] = useState(false);
  // The backend: the session being built from what was said, its progress line, and whether the talk has started.
  const session = useRef(null);
  const [loadStatus, setLoadStatus] = useState('');
  const [loaded, setLoaded] = useState(false);
  const sceneRef = useRef(null);
  const sceneAnim = useRef(null);
  // Seconds on the page-turn screen, for its timer.
  const [seconds, setSeconds] = useState(0);
  const holdingRef = useRef(false);
  const homeRef = useRef(null);
  const orbRef = useRef(null);
  const orbAnims = useRef([]);
  // The current press-and-release: what was heard, and whether its bubble has started forming.
  const round = useRef(null);
  const listen = useListen();
  // The talk listens to this phone's microphone (streamed to the backend); a note shows if that stops working.
  const talkMic = useRef(null);
  const [micNote, setMicNote] = useState('');
  const endTalkMic = () => {
    talkMic.current?.close();
    talkMic.current = null;
    closeMic();
    setMicNote('');
  };

  useEffect(() => {
    if (stage !== 'turning') return;
    const start = Date.now();
    setSeconds(0);
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 250);
    return () => clearInterval(id);
  }, [stage]);

  const press = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    navigator.vibrate?.(20);
    holdingRef.current = true;
    setHolding(true);
    setBubble(null);
    endRound();
    orbAnims.current.forEach((a) => a.cancel());
    orbAnims.current = [];
    listen.start();
  };

  const endRound = () => {
    round.current?.timers.forEach(clearTimeout);
    round.current = null;
  };

  // After hearing something, the words stay up for a moment, then fade and blur out as the button
  // grows into the wheel.
  const moveOn = (r) => {
    r.timers.push(
      setTimeout(() => setStage('wheel'), READ_MS),
      setTimeout(() => setBubble(null), READ_MS + BUBBLE_OUT_MS),
    );
  };

  // How far the wheel has been turned, 0–1: the gradient grows with it (via --p in styles.css).
  const setProgress = (p) => homeRef.current.style.setProperty('--p', p);

  // The line has reached the arrow: the glowing orb shows in the ring until the backend has the sounds
  // and the talk has started, then the ring undraws and the background shrinks into the pages.
  const finishWheel = () => {
    setDone(true);
    setLoaded(false);
    setLoadStatus('');
    const r = { timers: [] };
    round.current = r;
    r.timers.push(setTimeout(() => setStage('launch'), DONE_PAUSE_MS));
    const minWait = new Promise((res) => setTimeout(res, DONE_PAUSE_MS + LOADER_MIN_MS));
    const ready = (async () => {
      if (!session.current) throw new Error("Didn't catch the theme. Hold and speak again.");
      const id = await session.current;
      setLoadStatus('Planning your sounds…');
      await whenReady(id, (n, total) => total && setLoadStatus(`Gathering sounds · ${n}/${total}`));
      const micToken = await startTalk(id, TALK_MINUTES);
      // the talk hears this phone: stream the mic (opened on the hold-to-speak press) with the talk's token
      if (micToken && round.current === r) {
        const mic = streamMic({ mode: 'talk', token: micToken });
        talkMic.current = mic;
        mic.onError = (e) => { if (e && talkMic.current === mic) setMicNote(`${e.message} The talk can't hear you.`); };
        mic.ready.catch((e) => { if (talkMic.current === mic) setMicNote(`${e.message} The talk can't hear you.`); });
      }
    })();
    Promise.all([ready, minWait]).then(
      () => {
        if (round.current !== r) return;
        setLoaded(true);
        r.timers.push(
          setTimeout(shrink, RING_OUT_MS),
          setTimeout(() => setStage('turning'), RING_OUT_MS + SHRINK_MS),
        );
      },
      (e) => {
        if (round.current !== r) return;
        setLoadStatus(e.message);
        r.timers.push(setTimeout(backHome, ERROR_MS));
      },
    );
  };

  // Something went wrong while loading: back to the start, ready to hold and speak again.
  const backHome = () => {
    endRound();
    endTalkMic();
    session.current = null;
    setProgress(0);
    setDone(false);
    setLoaded(false);
    setLoadStatus('');
    setStage('home');
  };

  // Scales the whole background down to the size and shape of the pages, which then take over.
  const shrink = () => {
    setStage('shrink');
    const box = homeRef.current.getBoundingClientRect();
    const u = Math.min(box.width / 402, box.height / 874);
    const sx = (PAGES.w * u) / box.width;
    const sy = (PAGES.h * u) / box.height;
    // Rounded corners measured before scaling, so they come out as the pages' 26px once scaled.
    const radius = `${(26 * u) / sx}px / ${(26 * u) / sy}px`;
    sceneAnim.current = sceneRef.current.animate(
      [
        { transform: 'none', borderRadius: '0px' },
        { transform: `scale(${sx}, ${sy})`, borderRadius: radius },
      ],
      { duration: SHRINK_MS, easing: 'cubic-bezier(0.65, 0, 0.3, 1)', fill: 'forwards' },
    );
  };

  // Tapping the page-turn screen grows the background back out and returns to the start.
  const reset = () => {
    if (stage !== 'turning') return;
    stopTalk();
    endTalkMic();
    session.current = null;
    endRound();
    orbAnims.current.forEach((a) => a.cancel());
    orbAnims.current = [];
    setBubble(null);
    setStage('closing');
    setProgress(0);
    sceneAnim.current?.reverse();
    const r = {
      timers: [
        setTimeout(() => {
          sceneAnim.current?.cancel();
          sceneAnim.current = null;
          setDone(false);
          setStage('home');
        }, SHRINK_MS),
      ],
    };
    round.current = r;
  };

  const release = () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    setFlying(true);
    fly();

    // The bubble forms on schedule; the words blur in whenever recognition hands them over,
    // so the animation never stops to wait for them.
    const r = { text: null, heard: false, formed: false, timers: [] };
    round.current = r;
    r.timers.push(
      setTimeout(() => {
        r.formed = true;
        setFlying(false);
        setBubble({ id: Date.now(), text: r.text });
        if (r.heard) moveOn(r);
      }, FLIGHT_MS * FORM_AT),
    );
    listen.stop().then((text) => {
      if (round.current !== r) return; // a newer press took over
      r.text = text || listen.lastError() || NOTHING_HEARD;
      if (!text) closeMic(); // nothing to go on: turn the mic off until the next press
      r.heard = Boolean(text);
      // The theme is in: planning and fetching start now, while the wheel is being turned.
      if (r.heard) {
        session.current = startSession(text);
        session.current.catch(() => {}); // reported by the loader
      }
      if (!r.formed) return;
      setBubble((b) => b && { ...b, text: r.text });
      if (r.heard) moveOn(r);
    });
  };

  // Carries the orb from the button to the bubble, scaled from mockup px to this screen.
  const fly = () => {
    const box = homeRef.current.getBoundingClientRect();
    const u = Math.min(box.width / 402, box.height / 874);
    const at = (x, y) => ({ left: `${(box.width - 402 * u) / 2 + x * u}px`, top: `${(box.height - 874 * u) / 2 + y * u}px` });
    const orb = orbRef.current;

    // Where it is: one continuous move, slow out of the button and slow into place.
    const move = orb.animate([at(BUTTON.x, BUTTON.y), at(BUBBLE.x, BUBBLE.y)], {
      duration: FLIGHT_MS * ARRIVE,
      easing: 'cubic-bezier(0.55, 0, 0.25, 1)',
      fill: 'forwards',
    });
    // What it looks like: eased between each shape.
    const shape = orb.animate(
      SHAPE.map((f) => ({
        offset: f.offset,
        easing: 'ease-in-out',
        width: `${f.w * u}px`,
        height: `${f.h * u}px`,
        borderRadius: `${f.r * u}px`,
        filter: `blur(${f.blur * u}px)`,
        opacity: f.opacity,
      })),
      { duration: FLIGHT_MS, fill: 'forwards' },
    );
    orbAnims.current.push(move, shape);
  };

  return (
    <main ref={homeRef} className={`home stage-${stage} ${holding ? 'holding' : ''} ${flying ? 'flying' : ''}`}>
      {/* The background: it fills with orange and yellow as the wheel turns, then scales down into the pages. */}
      <div ref={sceneRef} className="scene">
        <WaveGradient />
        <div className="grow" aria-hidden="true" />
        <Grid />
      </div>

      {/* The prompt blurs into focus on the home screen and back out as soon as the button is pressed. */}
      <p className={`prompt ${stage === 'home' && !holding && !flying && !bubble ? '' : 'hidden'}`}>
        What’s Your
        <br />
        Story About?
      </p>

      {/* The glow on its way up; drawn under the button so it emerges from behind it. */}
      <div ref={orbRef} className="orb" aria-hidden="true" />

      {bubble && (
        <p key={bubble.id} className={`bubble ${bubble.text ? '' : 'waiting'}`} role="status">
          {bubble.text && (
            <span key={bubble.text} className="words">
              {bubble.text}
            </span>
          )}
        </p>
      )}

      <div className="hold-area">
        {/* The glow that flows out from behind the button while it's held. */}
        <div className="flow" aria-hidden="true" />
        <div className="ring one" aria-hidden="true" />
        <div className="ring two" aria-hidden="true" />

        <button
          className="hold"
          disabled={stage !== 'home'}
          aria-label="Hold to speak"
          onPointerDown={press}
          onPointerUp={release}
          onPointerCancel={release}
          onLostPointerCapture={release}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="dot" />
        </button>
      </div>

      {(stage === 'wheel' || stage === 'launch') && (
        <Wheel
          done={done}
          leaving={stage === 'launch'}
          ready={loaded}
          status={loadStatus}
          onProgress={setProgress}
          onDone={finishWheel}
        />
      )}

      {(stage === 'turning' || stage === 'closing') && (
        <div className="turn-layer" onClick={reset}>
          <PageTurn story time={`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`} />
          {micNote && <p className="mic-note" role="alert">{micNote}</p>}
        </div>
      )}

      {/* Everything goes soft and comes back into focus as the background shrinks and grows. */}
      {(stage === 'shrink' || stage === 'closing') && <div key={stage} className="wipe-blur" aria-hidden="true" />}

      <div className="grain" aria-hidden="true" />
    </main>
  );
}
