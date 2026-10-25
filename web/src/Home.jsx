import { useEffect, useRef, useState } from 'react';
import Fire from './Fire.jsx';
import Grid from './Grid.jsx';
import PageTurn from './PageTurn.jsx';
import WaveGradient from './WaveGradient.jsx';
import Strike from './Strike.jsx';
import Wheel from './Wheel.jsx';
import { listenSupported, useListen } from './useListen.js';
import { createRoom, getRoom, startSession, startTalk, stopTalk, whenReady } from './backend.js';

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

// "Create a Story" morphing into the black button; matches .start in styles.css.
const INTRO_OUT_MS = 1000;
// How often a listener asks the backend whether the story has started or ended.
const POLL_MS = 1000;

// The pages, in mockup px: the background scales down to exactly this.
const PAGES = { w: 344, h: 747 };

const NOTHING_HEARD = listenSupported
  ? "Didn't catch that. Hold and speak."
  : "This browser can't listen. Try Safari or Chrome.";

const INTRO_STAGES = ['intro', 'choose', 'code', 'introOut', 'join', 'waiting'];

export default function Home() {
  const [holding, setHolding] = useState(false);
  const [flying, setFlying] = useState(false);
  const [bubble, setBubble] = useState(null);
  // 'intro' (the fire and "Tell a Story") → 'choose' (create or join a story)
  //   create: 'introOut' (the button morphs into the black one) → 'home' (hold to speak) → 'wheel' (turn it to the
  //           arrow) → 'launch' (the ring undraws) → 'shrink' (the background scales down into the pages) →
  //           'turning' (the page-turn loop, the talk), then 'closing' on the way back to home
  //   join:   'join' (type the code) → 'waiting' (until the storyteller starts) → 'shrink' → 'turning' (same talk page)
  const [stage, setStage] = useState('intro');
  const stageRef = useRef(stage);
  stageRef.current = stage;
  // The story room: its code (made by the server), and whether this screen tells the story or listens to it.
  const [room, setRoom] = useState('');
  const [role, setRole] = useState(null); // 'host' | 'listener'
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // When the talk started, on this device's clock, so every screen in the room shows the same timer.
  const liveSince = useRef(0);
  const endedAt = useRef(0);
  // A listener's waiting line: what the storyteller is doing right now (kept a few seconds after a story ends).
  const waitingNote = (r) =>
    Date.now() - endedAt.current < 6000 ? 'The story ended. Waiting for the next one…'
      : r.phase === 'preparing' ? `Story: “${r.theme}”. Getting the sounds ready${r.total ? ` · ${r.done}/${r.total}` : '…'}`
        : 'The storyteller is choosing a story…';
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

  useEffect(() => {
    if (stage !== 'turning') return;
    const start = liveSince.current || Date.now();
    setSeconds(0);
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 250);
    return () => clearInterval(id);
  }, [stage]);

  // LISTENERS follow the room: the talk page opens when the story starts and closes when it ends.
  useEffect(() => {
    if (role !== 'listener' || !room) return;
    let stopped = false;
    const tick = async () => {
      let r;
      try { r = await getRoom(room); } catch { return; } // a missed poll is retried next second
      if (stopped) return;
      const now = stageRef.current;
      if (!r) { leaveRoom('That story has ended.'); return; }
      // while waiting, show where the storyteller is: choosing a story, or the sounds for it loading
      if (now === 'waiting' && r.state !== 'live') setNote(waitingNote(r));
      if (r.state === 'live' && now === 'waiting') {
        liveSince.current = Date.now() - Math.max(0, r.serverNow - r.startedAt);
        setNote('');
        shrink();
        setTimeout(() => stageRef.current === 'shrink' && setStage('turning'), SHRINK_MS);
      } else if (r.state !== 'live' && now === 'turning') {
        closePages('waiting');
        setNote('The story ended. Waiting for the next one…');
        endedAt.current = Date.now();
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [role, room]);

  // "Tell a Story" → choose: create a new story or join one with a code.
  const chooseStory = () => { setNote(''); setStage('choose'); };

  // CREATE: the backend makes the room and its code; then the button morphs into the hold button as before.
  const createStory = async () => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      const c = await createRoom();
      setRoom(c);
      setRole('host');
      setStage('code'); // show the code big first, so it can be shared before the story starts
      setNote('Share this code so others can join your story');
    } catch (e) {
      setNote(e.message);
    } finally {
      setBusy(false);
    }
  };

  // The code has been shared: "Start Telling" morphs into the hold button, as "Tell a Story" used to.
  const startTelling = () => {
    setNote('');
    setStage('introOut');
    setTimeout(() => setStage('home'), INTRO_OUT_MS);
  };
  const copyCode = () => {
    navigator.clipboard?.writeText(room).then(() => setNote(`Copied ${room}. Share it so others can join`), () => {});
  };

  // JOIN: check the code with the backend, then wait for the storyteller to start.
  const joinStory = async (e) => {
    e?.preventDefault();
    const c = code.trim().toUpperCase();
    if (busy || c.length < 4) return;
    setBusy(true);
    setNote('');
    try {
      const r = await getRoom(c);
      if (!r) { setNote('No story with that code. Check it and try again.'); return; }
      setRoom(r.code);
      setRole('listener');
      setStage('waiting');
      setNote(r.state === 'live' ? '' : waitingNote(r));
    } catch {
      setNote('Backend not reachable. Is it running on the laptop?');
    } finally {
      setBusy(false);
    }
  };

  // A listener leaves (or the room is gone): back to the opening screen.
  const leaveRoom = (message = '') => {
    setRole(null);
    setRoom('');
    setCode('');
    if (stageRef.current === 'turning') closePages('intro');
    else setStage('intro');
    setNote(message);
  };

  // The talk page grows back out into the background, then `to` takes over.
  const closePages = (to) => {
    liveSince.current = 0;
    setStage('closing');
    sceneAnim.current?.reverse();
    setTimeout(() => {
      sceneAnim.current?.cancel();
      sceneAnim.current = null;
      setStage(to);
    }, SHRINK_MS);
  };

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
      await startTalk(id, TALK_MINUTES, room);
      liveSince.current = Date.now(); // the timer counts from the talk's start, same as on listeners' screens
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
    if (role === 'listener') return leaveRoom(); // a listener only leaves; the storyteller's talk goes on
    stopTalk(room);
    liveSince.current = 0;
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
      r.text = text || NOTHING_HEARD;
      r.heard = Boolean(text);
      // The theme is in: planning and fetching start now, while the wheel is being turned.
      if (r.heard) {
        session.current = startSession(text, room);
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
      {!INTRO_STAGES.includes(stage) && (
        <p className={`prompt ${stage === 'home' && !holding && !flying && !bubble ? '' : 'hidden'}`}>
          What’s Your
          <br />
          Story About?
        </p>
      )}

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

      {/* The opening screens: the fire and the name stay while you choose, type a code or wait. */}
      {INTRO_STAGES.includes(stage) && (
        <div className="intro">
          <Strike className="strike" />
          <Fire className="fire" />
          <p className="title">SYNCOPATION</p>

          {stage === 'intro' && (
            <button key="tell" className="start" onClick={chooseStory}>
              <span>Tell a Story</span>
            </button>
          )}

          {(stage === 'code' || stage === 'introOut') && (
            <>
              <p className="code-label">YOUR STORY CODE</p>
              <button key="mycode" className="start start-alt start-code" onClick={copyCode} disabled={stage !== 'code'} aria-label={`Story code ${room}, tap to copy`}>
                <span>{room}</span>
              </button>
              {/* Sits where "Tell a Story" was, so it morphs into the hold button like before. */}
              <button key="go" className="start" onClick={startTelling} disabled={stage !== 'code'}>
                <span>Start Telling</span>
              </button>
            </>
          )}

          {stage === 'choose' && (
            <>
              <button key="join" className="start start-alt" onClick={() => { setNote(''); setStage('join'); }} disabled={busy}>
                <span>Join a Story</span>
              </button>
              <button key="create" className="start" onClick={createStory} disabled={busy}>
                <span>{busy ? 'Creating…' : 'Create a Story'}</span>
              </button>
            </>
          )}

          {stage === 'join' && (
            <form key="code" className="start code-form" onSubmit={joinStory}>
              <input
                className="code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                placeholder="Enter code"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck="false"
                aria-label="Story code"
                autoFocus
              />
              <button className="code-go" type="submit" disabled={busy || code.length < 4} aria-label="Join">
                →
              </button>
            </form>
          )}

          {stage === 'waiting' && (
            <p key="wait" className="start start-static">
              <span>Story {room}</span>
            </p>
          )}

          {note && <p className="intro-note" role="status">{note}</p>}
          {(stage === 'choose' || stage === 'join' || stage === 'waiting') && (
            <button className="intro-back" onClick={() => (stage === 'waiting' ? leaveRoom() : stage === 'join' ? setStage('choose') : setStage('intro'))}>
              {stage === 'waiting' ? 'Leave' : 'Back'}
            </button>
          )}
        </div>
      )}

      {/* The storyteller's code, so others can join; shown until the story is told. */}
      {role === 'host' && room && !INTRO_STAGES.includes(stage) && (
        <p className="room-code" aria-label={`Story code ${room}`}>STORY {room}</p>
      )}

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
        </div>
      )}

      {/* Everything goes soft and comes back into focus as the background shrinks and grows. */}
      {(stage === 'shrink' || stage === 'closing') && <div key={stage} className="wipe-blur" aria-hidden="true" />}

      <div className="grain" aria-hidden="true" />
    </main>
  );
}
