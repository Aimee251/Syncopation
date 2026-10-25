// predict.ts — Syncopation prediction model, one file.
//
//   npx tsx predict.ts           live mic → stt.ts (speech-to-text) → this prediction model
//   npx tsx predict.ts --type    type lines instead of speaking (no mic / STT key needed)
//   --type --stream              replays typed lines word by word, to test early firing
//   /test 80                     label what you say next (e.g. 80% related to the summary) → scored per label at /end
//   --speed 10                   testing only: the clock runs 10x faster, so a short test covers a whole talk
//
// Everything a UI would do happens in the console: setup questions at the start, then /commands
// while you talk (/help lists them).
// Needs ANTHROPIC_API_KEY in the environment. Stage 1 (sound search) is hardcoded below.

import * as readline from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listen, setKeyterms } from "./stt"; // live voice → text lives in stt.ts
import { createMonitor, type Found } from "./monitor";
import { playOnce, setLoop, setLevel, stopAll, duck, playerName, startMixer, startRoom, waitForBrowser, preload, pickCompatible, setMixLogger, soundProfile, setSpace } from "./mixer"; // browser mixer with afplay fallback (player.ts)
import { expandLibrary, finishLibrary } from "./scripts/buildLibrary"; // extra scraping rounds while the talk is running
import { providerStatus } from "./convex/lib/pipeline";
import { inTalkChild } from "./room/talkBridge";

// =====================================================================
// 1. TALK + SOUND LIBRARY
//    Nothing below is tied to one story. STORY values are only defaults for the setup questions.
//    The library comes from library.json (stage 1 output, see library.example.json) or --library <file>;
//    the built-in demo library is used only when no file exists.
//    At startup Claude "reads" the library once and writes trigger phrases for every sound, so any
//    library from the sound search works without hand-written tags.
// =====================================================================
const STORY = {
  summary: "A spooky campfire story about two friends exploring an abandoned house on a stormy night. Slow build, one big scare at the end.",
  keywords: ["door", "storm", "footsteps", "stairs", "ghost"],
  tone: "eerie, slow build, one big scare",
  moods: ["calm", "uneasy", "tense", "terror"],
  density: "normal" as "subtle" | "normal" | "expressive",
};

type Sound = {
  id: string; role: "sfx" | "stinger" | "ambience" | "music"; tags: string[]; intensity: number;
  mood?: string; setting?: string; description?: string; files?: string[]; // audio variants on disk (scraper output)
  instant?: string[] // phrases that NAME the sound or its action ("dog barks", "gunshot"): safe to fire the moment they are heard
  emphasis?: number // STORY WEIGHT 0 = incidental .. 1 = pivotal (not loudness: the scene decides how it is mixed)
  softness?: number // the sound's own character: 0 = sharp transient .. 1 = gentle, diffuse
  lengthS?: number // planner: how long the sound should last (the clip is trimmed to about this at playback)
  attack?: number // planner: 0 = instant onset .. 1 = slow swell in
  tail?: number // planner: 0 = clean cut .. 1 = long lingering fade out
};
const fileOf = (s?: Sound) => (s?.files?.length ? s.files[Math.floor(Math.random() * s.files.length)] : undefined);
// Looping beds go through player.ts; a layer with no audio file (e.g. no ambience scraped) is left alone
function startBed(name: "music" | "ambience", s?: Sound) {
  const file = name === "music" && s?.files?.length ? pickCompatible(s.files) : fileOf(s);
  if (file) setLoop(name, file, name === "music" ? mix.music : mix.ambience);
}
process.on("exit", stopAll);
// End of talk: music and ambience fade out (~0.5 s) instead of cutting off, then quit
// onnxruntime (the embedding model) crashes in its own clean-up on macOS ("libc++abi … mutex lock failed") and disposing it
// races embedding calls still in flight ("Session already disposed"), so after the report the process ends without
// running native clean-up. The report and weights are written before this.
const fadeOutAndExit = () => {
  stopAll();
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 1000);
};
// /end and Ctrl+C both land here; the report is printed once
let ended = false;
function endTalk() { if (ended) return; ended = true; printTimeline(); saveWeights(); fadeOutAndExit(); }
const DEMO_LIBRARY: Sound[] = [
  { id: "door_creak", role: "sfx", tags: ["door", "creak", "open"], intensity: 0.6 },
  { id: "footsteps_wood", role: "sfx", tags: ["footsteps", "steps", "walking", "stairs"], intensity: 0.5 },
  { id: "thunder", role: "sfx", tags: ["thunder", "storm", "lightning"], intensity: 0.8 },
  { id: "whisper", role: "sfx", tags: ["whisper", "voice", "ghost"], intensity: 0.7 },
  { id: "glass_break", role: "sfx", tags: ["glass", "break", "window", "crash"], intensity: 0.8 },
  { id: "knock", role: "sfx", tags: ["knock", "knocking"], intensity: 0.6 },
  // multi-word tags match as a phrase: "her" alone ("her cooking") must not trigger a jump scare
  { id: "riser", role: "stinger", tags: ["suddenly", "something was coming"], intensity: 0.8 },
  { id: "hit", role: "stinger", tags: ["saw her", "saw him", "standing there", "scream"], intensity: 1.0 },
  { id: "rain_amb", role: "ambience", tags: ["rain"], intensity: 0.3, setting: "storm outside" },
  { id: "house_amb", role: "ambience", tags: ["house"], intensity: 0.3, setting: "inside the house" },
  { id: "forest_amb", role: "ambience", tags: ["forest"], intensity: 0.2, setting: "forest" },
  { id: "music_calm", role: "music", tags: [], intensity: 0.2, mood: "calm" },
  { id: "music_uneasy", role: "music", tags: [], intensity: 0.4, mood: "uneasy" },
  { id: "music_tense", role: "music", tags: [], intensity: 0.7, mood: "tense" },
  { id: "music_terror", role: "music", tags: [], intensity: 0.9, mood: "terror" },
];
const libArg = process.argv.indexOf("--library");
const LIBRARY_FILE = libArg >= 0 ? process.argv[libArg + 1] : "library.json";
let LIBRARY: Sound[] = DEMO_LIBRARY;
// Scraper records → sounds. Several variants per slot (door_creak#0, #1) merge into one sound with many files.
// Used at startup, for batch 2 and for the live top-ups, so music / ambience / effects are always told apart the same way.
function toSounds(records: any[], dir: string): Sound[] {
  const bySlot = new Map<string, Sound>();
  for (const x of records) {
    const id = String(x.slotId ?? x.id ?? x.soundId);
    const file = x.url ? join(dir, String(x.url).replace(/^\//, "")) : undefined;
    const have = bySlot.get(id);
    if (have) { if (file && existsSync(file)) (have.files ??= []).push(file); continue; }
    const isBed = x.role ? x.role === "ambience" : x.layer !== "music" && (x.loop || /ambien|atmos|drone|background|room tone/i.test(`${id} ${x.label ?? ""}`));
    bySlot.set(id, {
      id, tags: x.tags ?? [], intensity: Number(x.intensity ?? 0.5),
      // layer music → music bed; looping/ambience sounds → ambience bed; speculative sfx (riser/swell) → stinger; everything else → sfx
      role: x.role ?? (x.layer === "music" ? "music" : isBed ? "ambience" : x.safety === "speculative" ? "stinger" : "sfx"),
      mood: x.mood, setting: x.setting ?? (isBed ? String(x.label ?? id).toLowerCase() : undefined),
      description: x.description ?? `${x.label ?? x.title ?? ""}${Array.isArray(x.tags) && x.tags.length ? " — " + x.tags.slice(0, 6).join(", ") : ""}`,
      files: file && existsSync(file) ? [file] : [],
      emphasis: typeof x.emphasis === "number" ? x.emphasis : undefined,
      softness: typeof x.softness === "number" ? x.softness : undefined,
      lengthS: typeof x.lengthS === "number" ? x.lengthS : undefined,
      attack: typeof x.attack === "number" ? x.attack : undefined,
      tail: typeof x.tail === "number" ? x.tail : undefined,
      instant: Array.isArray(x.instant) && x.instant.length ? x.instant.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean) : undefined, // phrases written by the planner
    });
  }
  return [...bySlot.values()];
}
if (existsSync(LIBRARY_FILE)) {
  try {
    const raw = JSON.parse(readFileSync(LIBRARY_FILE, "utf8"));
    LIBRARY = toSounds(Array.isArray(raw) ? raw : raw.sounds, dirname(LIBRARY_FILE));
  } catch (e) { console.error(`Couldn't read ${LIBRARY_FILE} (${(e as Error).message}) — using the demo library`); }
}
let CUES = LIBRARY.filter(s => s.role === "sfx" || s.role === "stinger");
// Music moods and ambience settings come from the LIBRARY, not from any one story
let MOODS: string[] = [];
let SETTINGS: string[] = [];
// Fallback when no AI prep exists: multi-word tags and tags that name a noise are "instant"; bare nouns (door, dog) never are
const EVENT_WORD = /^(\w*bell|bark|ring|rang|slam|crash|shot|scream|bang|smash|ding|clang|creak|thud|pop|splat|honk|boom|clap|knock|shatter|explod|gunshot|siren|alarm|thunder|whoosh|sneez|cough|laugh|gasp|buzz|beep|click|clink|squeak|snap|howl|growl|roar|splash|drip|crack|cheer|applaus|zap|blast|cackl)/;
const heuristicInstant = (s: Sound) => [...new Set([...s.tags, ...s.id.split("_")].map(t => t.toLowerCase()).filter(t => t.includes(" ") || EVENT_WORD.test(t)))];
function indexLibrary() {
  CUES = LIBRARY.filter(s => s.role === "sfx" || s.role === "stinger");
  // no AI prep → heuristic phrases; with prep, single words that ARE a noise ("thunder", "bang", "crash") are added too
  for (const s of CUES) s.instant = s.instant?.length
    ? [...new Set([...s.instant, ...[...s.tags, ...s.id.split("_")].map(t => t.toLowerCase()).filter(t => !t.includes(" ") && EVENT_WORD.test(t))])]
    : heuristicInstant(s);
  MOODS = [...new Set(LIBRARY.filter(s => s.role === "music" && s.mood).map(s => s.mood!))];
  if (!MOODS.length) MOODS = STORY.moods;
  SETTINGS = [...new Set(LIBRARY.filter(s => s.setting).map(s => s.setting!))];
}
indexLibrary();

// LIBRARY PREP (once per library, cached): Claude writes, for every sound effect, the phrases that mean the
// sound is HAPPENING (any wording, any topic) plus a one-line description used for meaning-based matching.
// The scraper's planner already writes this metadata for every sound it fetches; this pass only covers sounds without it
// (older sessions, hand-made libraries), and runs in the background so it never delays the start of a talk.
async function prepareLibrary() {
  const todo = CUES.filter(s => !s.instant?.length || s.emphasis === undefined || s.softness === undefined);
  if (!todo.length) return "metadata came with the sounds (no prep call)";
  const cacheFile = "library.prepared.json";
  const key = "v4" + JSON.stringify(LIBRARY.map(s => [s.id, s.role, s.tags, s.description]));
  if (existsSync(cacheFile)) try {
    const c = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (c.key === key) {
      // merge into the live sounds (never swap the library under a running talk); audio paths stay this session's
      for (const cs of c.library as Sound[]) {
        const s = LIBRARY.find(x => x.id === cs.id);
        if (s) Object.assign(s, { tags: cs.tags, instant: s.instant?.length ? s.instant : cs.instant, emphasis: s.emphasis ?? cs.emphasis, softness: s.softness ?? cs.softness, description: cs.description, intensity: cs.intensity });
      }
      indexLibrary(); return "cached";
    }
  } catch { }
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-5-5", max_tokens: 8000,
        tools: [{
          name: "prep", description: "Trigger phrases per sound", input_schema: {
            type: "object", required: ["sounds"], properties: {
              sounds: {
                type: "array", items: {
                  type: "object", required: ["id", "triggers", "instant", "description", "intensity", "emphasis", "softness"], properties: {
                    id: { type: "string", enum: todo.map(s => s.id) },
                    triggers: { type: "array", maxItems: 12, items: { type: "string" }, description: "short words/phrases a speaker would say when this sound is actually happening (verbs and events, several wordings, no generic words like 'her' or 'night')" },
                    instant: { type: "array", maxItems: 6, items: { type: "string" }, description: "phrases that NAME this sound or its action so clearly the audience expects to HEAR it on that word (e.g. 'barks', 'barking', 'doorbell rings', 'gunshot', 'smoke alarm goes off'). Never a bare noun or place ('dog', 'door', 'kitchen').", },
                    description: { type: "string", description: "one line: the event this sound represents" },
                    intensity: { type: "number" },
                    emphasis: { type: "number", description: "STORY WEIGHT 0..1, not loudness: 0-0.3 incidental detail, 0.4-0.6 supporting moment, 0.7-1 a pivotal event the story turns on." },
                    softness: { type: "number", description: "0..1 the sound's own character: 0 = sharp harsh transient, 0.5 = ordinary, 1 = gentle and diffuse." }
                  }
                }
              }
            }
          }
        }],
        tool_choice: { type: "tool", name: "prep" },
        messages: [{
          role: "user", content: `Prepare this sound library for live, unscripted speech of ANY topic.\n` +
            todo.map(s => `- ${s.id} (${s.role}): ${s.description || ""} tags: ${s.tags.join(", ")}`).join("\n")
        }],
      }),
    });
    const data: any = await res.json();
    const out = data.content?.find((b: any) => b.type === "tool_use")?.input?.sounds ?? [];
    for (const o of out) {
      const s = LIBRARY.find(x => x.id === o.id);
      if (!s) continue;
      s.tags = [...new Set([...s.tags, ...(o.triggers ?? []).map((t: string) => t.toLowerCase().trim())])].filter(Boolean);
      if (Array.isArray(o.instant) && o.instant.length) s.instant = [...new Set(o.instant.map((t: string) => t.toLowerCase().trim()))].filter(Boolean) as string[];
      s.description = s.description || o.description;
      if (typeof o.intensity === "number" && !s.intensity) s.intensity = o.intensity;
      if (typeof o.emphasis === "number" && s.emphasis === undefined) s.emphasis = Math.max(0, Math.min(1, o.emphasis));
      if (typeof o.softness === "number" && s.softness === undefined) s.softness = Math.max(0, Math.min(1, o.softness));
    }
    indexLibrary();
    if (!out.length) return `prep returned nothing (${data?.error?.message ?? data?.stop_reason ?? "no reply"}), using the library's own tags`;
    writeFileSync(cacheFile, JSON.stringify({ key, library: LIBRARY }, null, 2));
    return `prepared ${out.length} sounds`;
  } catch { return "prep failed, using the library's own tags"; }
}
// BIG PICTURE = THREADS. The talk is a set of story threads, not one script. Each thread remembers where it was
// left (story, state, tension, part of the arc, music, expectations, its own recent lines). The speaker can start
// a new thread, wander, and LOOP BACK: returning to a paused thread restores its state instantly instead of
// starting over. One thread is active at a time.
type Thread = {
  id: string; story: string; state: any; expects: any[]; liveWords: { word: string; sound: string }[];
  arc: string; usedInArc: number; music: string; ambience: string; lines: string[]
};
const threads: Thread[] = [];
let active: Thread = { id: "t1", story: "", state: null, expects: [], liveWords: [], arc: "setup", usedInArc: 0, music: "", ambience: "", lines: [] };
const storyNow = () => active.story || STORY.summary;

// =====================================================================
// 1b. TALK LENGTH — estimate at the start, change anytime with "/time N"
// =====================================================================
const flag = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? Number(process.argv[i + 1]) : undefined; };
const clock = { estMin: flag("minutes") ?? 0, speed: flag("speed") ?? 1, startedAt: 0 };
const elapsedMin = () => ((Date.now() - clock.startedAt) / 60_000) * clock.speed;
const progress = () => elapsedMin() / clock.estMin; // 0 = start, 1 = expected end, >1 = over time
const pct = () => `${Math.round(progress() * 100)}%`;
const clockText = () => `${elapsedMin().toFixed(1)} of ~${clock.estMin} min (${pct()})`;

// Where the story "should" be by time alone — Claude weighs this against what is actually said
function arcByTime(): string {
  const p = progress();
  return p < 0.2 ? "setup" : p < 0.6 ? "rising" : p < 0.85 ? "climax" : p < 1 ? "falling" : "resolution";
}
// Told to Claude on every call, so a changed estimate shows up in the very next prediction
function timeNote(): string {
  const p = progress();
  return `Time: ${clockText()}. By time alone the story would be around "${arcByTime()}".` +
    (p > 1 ? " The speaker is PAST their estimate: favour falling / resolution unless the speech clearly isn't ending." :
      p > 0.85 ? " Close to the end: the climax should be done or happening now." : "") +
    " The content of the speech wins over the clock if they disagree.";
}

// =====================================================================
// 2. (speech-to-text is in stt.ts)
// 3. SLOW LOOP — Claude predicts the next 3 moments (runs in background)
// =====================================================================
type State = {
  scene: string; setting: string; tension: number; arc: string; mood: string; on_topic: number; last_sound: string;
  listen_for: { word: string; sound: string }[]; sound_need: number; focus: string; focus_changed: boolean; continues_story: number;
  current_story: string; adopt_new_story: boolean; scenario: string; thread: string; fits_now?: string[];
  space?: string; fx_blend?: number // SCENE MIX (big picture): the room everything is in, and how effects sit against the music
};
type Slot = { slot: number; beat: string; sounds: { id: string; score: number }[]; missing?: { sound: string; p: number }[] };

function threadList(): string {
  return threads.map(t => `${t.id} = "${t.story || STORY.summary}" (${t === active ? "ACTIVE" : `paused at ${t.arc}, tension ${f2(t.state?.tension ?? 0.3)}`})`).join("; ");
}
// Save everything about the active thread so it can be resumed exactly where it was left
function snapshot() {
  // (active.state is saved separately, only from replies that really belong to this thread)
  Object.assign(active, {
    expects: [...expects], liveWords: [...liveWords], arc: mix.arc, usedInArc: mix.usedInArc,
    music: layer.music.now, ambience: layer.ambience.now
  });
}
function forceLayer(name: "music" | "ambience", value: string) {
  const L = layer[name];
  if (!value || value === L.now) return;
  L.now = value; L.vote = ""; L.n = 0;
  const found = LIBRARY.find(s => (name === "music" ? s.mood : s.setting) === value);
  say(C.music, "MUSIC", `SWITCH ${name} → ${value} (${found?.id}) [thread change, no vote needed]`);
  startBed(name, found);
}
// RESUME a paused thread: restore its state, expectations, keywords, arc position and music immediately
function switchTo(t: Thread, why: string) {
  if (t === active) return;
  snapshot();
  active = t;
  state = t.state;
  expects = t.expects.map((e: Expect) => ({ ...e, madeAt: index })); // restored guesses count as fresh
  liveWords = [...t.liveWords];
  mix.arc = (t.arc || "setup") as Arc; mix.usedInArc = t.usedInArc;
  say(C.music, "RESUME", `back to ${t.id} "${t.story}" — ${why}. Picking up at ${t.arc}, tension ${f2(t.state?.tension ?? 0.3)}`);
  forceLayer("music", t.music); forceLayer("ambience", t.ambience);
}
// NEW thread: the old one is paused (not forgotten), the new one starts fresh
function newThread(story: string) {
  snapshot();
  const t: Thread = {
    id: `t${threads.length + 1}`, story, state: null, expects: [], liveWords: [], arc: "setup", usedInArc: 0,
    music: layer.music.now, ambience: layer.ambience.now, lines: []
  };
  threads.push(t);
  const prev = active;
  active = t;
  expects = []; mix.arc = "setup"; mix.usedInArc = 0;
  say(C.music, "NEW STORY", `${t.id} "${story}" (${prev.id} "${prev.story}" is paused and can be resumed)`);
  planWholeSpeech(story).then(() => say(C.music, "PLAN", ARCS.map(a => `${a}: music ${f2(PLAN[a].music)}, ${budget(a)} sounds`).join(" | ")));
}
// FAST return detection (no Claude call): does this sentence clearly belong to a PAUSED thread?
async function pausedThreadMatch(text: string): Promise<{ t: Thread; sim: number } | null> {
  let best: { t: Thread; sim: number } | null = null;
  for (const t of threads) {
    if (t === active || !t.lines.length) continue;
    const sim = await similarity(text, [t.story, ...t.lines.slice(-3)].join(". "));
    if (!best || sim > best.sim) best = { t, sim };
  }
  return best;
}

// REGENERATE when the model's own scores stay low: if 3 on-topic sentences in a row don't match any prediction,
// or 2 sentences in a row deserved a sound Claude never saw coming, the current picture is wrong → rebuild it.
const rethink = { lowStreak: 0, surpriseStreak: 0, pending: false, reason: "" };
function scoreFeedback(kind: "fit" | "outcome", good: boolean, insert = false) {
  if (kind === "fit") { if (insert) return; rethink.lowStreak = good ? 0 : rethink.lowStreak + 1; }
  else rethink.surpriseStreak = good ? 0 : rethink.surpriseStreak + 1;
  const trigger = rethink.lowStreak >= 3 ? `${rethink.lowStreak} sentences in a row matched none of your predictions`
    : rethink.surpriseStreak >= 2 ? `${rethink.surpriseStreak} sounds in a row you didn't anticipate` : "";
  if (trigger && !rethink.pending) {
    rethink.pending = true; rethink.reason = trigger;
    say(C.music, "REGENERATE", `${trigger} → dropping old predictions, rebuilding the picture and the sound plan`);
    expects = [];
    planWholeSpeech(storyNow()).then(() => say(C.music, "PLAN", ARCS.map(a => `${a}: music ${f2(PLAN[a].music)}, ${budget(a)} sounds`).join(" | ")));
  }
}

async function predictNext3(recent: string[], index: number, prev: State | null): Promise<{ state: State; slots: Slot[]; ms: number } | null> {
  const started = Date.now();
  // SPEED: everything that changes every sentence (current story, threads, recent speech) goes in the message; the system
  // text below only changes when the library grows, so Claude's prompt cache reuses it and the answer starts sooner
  const system = `You track a live, unscripted talk for a sound designer and predict the next 5 moments.
Follow the SPEAKER, not the plan. The summary below is only a loose guess typed before the talk (it may be a few vague words, a genre label, or simply wrong).
Original summary: "${STORY.summary}"
The speaker may leave a thread and LOOP BACK to it later. Set "thread" to the thread the latest sentence belongs to:
an existing id if it continues or returns to that thread (pick up where it was left, don't restart it), "new" if it starts
a different story, "insert" for a one-off random line.
Keywords: ${STORY.keywords.join(", ")}. Tone: ${STORY.tone}. Density: ${STORY.density}.
Sound effects: ${CUES.map(s => `${s.id}${s.description ? ` = ${s.description}` : ""}`).join("; ")}
Music moods available: ${MOODS.join(", ")}. Ambiences: ${SETTINGS.join(", ") || "(none)"}. Set "setting" to "none" when no available ambience fits the place the speaker is actually in: a wrong bed is worse than none.
Rules: a slot is the next meaningful sentence. For slots +1 … +5 give the likely beat (under 8 words) and score up to 3 sounds 0..1.
The further ahead, the less sure: +4 and +5 are about where the story is HEADING (scene, likely events), which is what lets sounds be fetched in time.
When a likely beat would have a sound-making event that NO library sound covers, list it in that slot's "missing" with how likely it is
(you can't know the future: it's a bet; it is fetched now so it's ready if it comes).
SCENE MIX (the big picture of the soundtrack): set "space" to where the story is acoustically, and "fx_blend" to how effects should sit
against the music in THIS scene: melt in for gentle, tender or reflective moments, punch through for sudden danger or a comic beat that must land.
Keep every text field short.
listen_for words must name the sound-making EVENT (an action or a noise the audience would hear), never just a place, object or person.
If the latest sentence is a random insert that doesn't follow from the story so far, mark continues_story low and do NOT let it redirect
the story state, focus or predictions: keep the trajectory you had.
Most moments deserve no sound: ordinary details < 0.3; only setups, reveals, turns, strong actions score high.
Score sounds for things HAPPENING in the talk, not words mentioned in passing: talking ABOUT a sound is not the sound.
Do not bend unrelated details into the summary's genre or mood.
Treat the summary as a PRIOR and the speech as EVIDENCE: as more of the talk is heard, trust what the speaker actually says over what the summary led you to expect, and keep your beats,
predictions and sounds to what the evidence supports. Do not import plot elements, genre or tone that neither the speech nor the summary's own words support.
Stay consistent with the previous state unless the story clearly changed. Change tension gradually.
Use the time note to judge pacing: in most talks the biggest moment (climax, reveal, punchline, key point) lands 65-85% of the way through.
A single odd sentence is a random insert (low continues_story): ignore it.
But if the speaker has clearly moved to a DIFFERENT story or topic for 2+ sentences, set adopt_new_story and describe it in
current_story: from then on, follow that story. Never keep forcing the original summary onto a talk that has moved on.
Whatever the talk is about, use the available music moods and ambiences to make it more compelling (scenario):
there should always be fitting music; sound effects only where something happens.`;
  const tool = {
    name: "update_story", description: "Story state + next 5 slots",
    input_schema: {
      type: "object", required: ["state", "slots"],
      properties: {
        state: {
          type: "object", required: ["scene", "setting", "tension", "arc", "mood", "on_topic", "last_sound", "listen_for", "sound_need", "focus", "focus_changed", "continues_story", "current_story", "adopt_new_story", "thread", "space", "fx_blend"], properties: {
            thread: { type: "string", description: "which thread the latest sentence belongs to: an existing thread id, 'new', or 'insert'" },
            current_story: { type: "string", description: "under 12 words: the story or topic the speaker is ACTUALLY on now (may differ from the original summary)" },
            adopt_new_story: { type: "boolean", description: "true when the speaker has clearly switched to a different story/topic for 2+ sentences (not a single random insert)" },
            continues_story: { type: "number", description: "0..1: does the sentence that just finished actually follow from what came before (1) or is it a random insert that only sounds related (0)?" },
            sound_need: { type: "number", description: "0..1: how much the story RIGHT NOW calls for sound effects. 1 = vivid action or reveal the audience should hear; 0.5 = atmosphere; 0 = reflection, explanation, emotional confession or punchline where a sound would distract (let music carry it)." },
            focus: { type: "string", description: "the main thread or message of the story right now, in a few words" },
            focus_changed: { type: "boolean", description: "true if the main thread just switched (new topic, new message, flashback, different scene type), not just a new detail" },
            fits_now: { type: "array", maxItems: 8, items: { type: "string", enum: CUES.map(s => s.id) }, description: "BIG-PICTURE GATE: the sounds that would genuinely ENHANCE the speech if the speaker names them in the next ~20 s, given the whole story so far, its tone and where it is going. A sound that is merely related to a passing mention must NOT be here; a reflective, emotional or punchline moment may have an empty list. Named sounds outside this list stay silent." },
            listen_for: {
              type: "array", maxItems: 6, description: "ARMED TRIGGERS: exact words/phrases the speaker will probably say in the next ~20 s that name a sound-making EVENT (e.g. 'doorbell', 'smoke alarm', 'crash'). They are pre-approved: the sound plays INSTANTLY the moment the phrase is heard, with no further check. Only list events, never bare places/objects/people. Replaces the previous list, so drop what the story has moved past.",
              items: { type: "object", required: ["word", "sound"], properties: { word: { type: "string" }, sound: { type: "string", enum: CUES.map(s => s.id) } } }
            },
            last_sound: { type: "string", enum: [...CUES.map(s => s.id), "none"], description: "HINDSIGHT: the one sound effect that would have fit the sentence that just finished, or none. Be strict: most sentences are none." },
            on_topic: { type: "number", description: "0..1: how related the LATEST sentence is to the story the speaker is currently on (current_story), not the original summary. Low = a random insert." },
            scene: { type: "string" }, setting: { type: "string", ...(SETTINGS.length ? { enum: [...SETTINGS, "none"] } : {}) }, tension: { type: "number" },
            arc: { type: "string", enum: ["setup", "rising", "climax", "falling", "resolution"] },
            mood: { type: "string", enum: MOODS },
            space: { type: "string", enum: ["room", "hall", "cave", "outdoors"], description: "SCENE MIX: the acoustic space the story is in right now (sets the echo every effect and the ambience get)" },
            fx_blend: { type: "number", description: "SCENE MIX: 0..1 how sound effects should sit against the music right now, from the big picture: 0 = melt into the music (gentle opening, tender or reflective moment, bedtime-story tone), 0.5 = clearly heard but part of the soundtrack, 1 = punch through (sudden danger, a crash, a comic beat that needs to land)" }
          }
        },
        slots: {
          type: "array", minItems: 5, maxItems: 5, items: {
            type: "object", required: ["offset", "beat", "sounds"], properties: {
              offset: { type: "integer", enum: [1, 2, 3, 4, 5] }, beat: { type: "string" },
              missing: {
                type: "array", maxItems: 2, description: "sound-making events this moment would likely have that NO library sound covers (e.g. 'horse galloping'), with how likely each is. They are fetched now, so they are ready if they come; leave empty when the library covers it",
                items: { type: "object", required: ["sound", "p"], properties: { sound: { type: "string" }, p: { type: "number" } } }
              },
              sounds: {
                type: "array", maxItems: 3, items: {
                  type: "object", required: ["id", "score"], properties: {
                    id: { type: "string", enum: CUES.map(s => s.id) }, score: { type: "number" }
                  }
                }
              }
            }
          }
        },
      },
    },
  };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-5-5", max_tokens: 2200, // 5 slots: too low a limit cuts the reply off mid-answer
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: [tool], tool_choice: { type: "tool", name: "update_story" },
        messages: [{
          role: "user", content: `What the speaker is actually talking about now: "${storyNow()}"\nStory threads so far: ${threadList()}\nPrevious state: ${JSON.stringify(prev ?? {})}\n${timeNote()}\nStory so far:\n${recent.join("\n")}\nSentence [${index}] just finished. Judge it in hindsight (last_sound), then predict [${index + 1}] … [${index + 5}]. Rethink where the story is going from everything said so far; drop old expectations the speaker has moved past.${rethink.pending ? `
IMPORTANT: your recent predictions kept missing what the speaker actually said (${rethink.reason}). Throw away your old picture and rebuild it from scratch from the speech itself: what is this talk really about, where is it going next, which sounds will fit.` : ""}`
        }],
      }),
    });
    const data: any = await res.json();
    if (!res.ok) { console.error("Claude error:", data?.error?.message ?? data); return null; }
    if (data.stop_reason === "max_tokens") console.error("[CLAUDE] reply was cut off (max_tokens) — using what arrived");
    const out = data.content?.find((b: any) => b.type === "tool_use")?.input;
    if (!out?.state) { console.error("[CLAUDE] reply had no story state, skipping this update"); return null; }
    // Fill anything missing so one incomplete reply can never crash the loop
    // Anything missing or empty keeps its PREVIOUS value: an incomplete reply must never reset the story
    // (e.g. drop the music from "terror" back to "calm" in the middle of the climax)
    const st = out.state;
    const keep = <T>(v: T | undefined | null | "", fallback: T): T => (v === undefined || v === null || v === "" ? fallback : (v as T));
    const num = (v: any, fallback: number) => (typeof v === "number" && !Number.isNaN(v) ? v : fallback);
    const state: State = {
      scene: keep(st.scene, prev?.scene ?? ""), setting: keep(st.setting, prev?.setting ?? SETTINGS[0]),
      tension: num(st.tension, prev?.tension ?? 0.3), arc: keep(st.arc, prev?.arc ?? "setup"),
      mood: keep(st.mood, prev?.mood ?? MOODS[0]), on_topic: num(st.on_topic, prev?.on_topic ?? 0.5),
      last_sound: keep(st.last_sound, "none"),
      listen_for: Array.isArray(st.listen_for) && st.listen_for.length ? st.listen_for : prev?.listen_for ?? [],
      fits_now: Array.isArray(st.fits_now) ? st.fits_now : prev?.fits_now,
      sound_need: num(st.sound_need, prev?.sound_need ?? 0.5),
      focus: keep(st.focus, prev?.focus ?? ""), focus_changed: !!st.focus_changed, continues_story: num(st.continues_story, 1),
      current_story: keep(st.current_story, prev?.current_story ?? ""), adopt_new_story: !!st.adopt_new_story,
      scenario: keep(st.scenario, prev?.scenario ?? ""), thread: keep(st.thread, ""),
      space: keep(st.space, prev?.space ?? "room"), fx_blend: num(st.fx_blend, prev?.fx_blend ?? 0.5),
    };
    const missing = ["scene", "arc", "mood", "tension", "focus"].filter(k => st[k] === undefined || st[k] === "");
    if (missing.length) console.error(`[CLAUDE] reply left out ${missing.join(", ")} — kept the previous values`);
    if (!Array.isArray(out.slots) || !out.slots.length) console.error("[CLAUDE] reply had no predictions — the previous ones stay active");
    const slots: Slot[] = (Array.isArray(out.slots) ? out.slots : [])
      .filter((s: any) => s && typeof s.offset === "number")
      .map((s: any) => ({ slot: index + s.offset, beat: s.beat ?? "", sounds: Array.isArray(s.sounds) ? s.sounds : [],
        missing: Array.isArray(s.missing) ? s.missing.filter((m: any) => m && typeof m.sound === "string" && typeof m.p === "number") : [] }));
    return { state, ms: Date.now() - started, slots };
  } catch (e) {
    console.error("Claude call failed:", e);
    return null;
  }
}

// ANTICIPATION POOL — what Claude expects to happen soon, NOT pinned to an exact sentence.
// Speakers dawdle or skip ahead: the door Claude expected "in 2 sentences" may come in 4, or in 1.
// So the fast loop checks the CURRENT words against everything still expected, and takes the best match.
type Expect = { id: string; score: number; beat: string; madeAt: number; offset: number };
let expects: Expect[] = [];

function ingestPrediction(madeAt: number, slots: Slot[]) {
  expects = expects.filter(e => madeAt - e.madeAt < 3 && e.madeAt + e.offset >= madeAt); // forget stale and passed guesses
  for (const sl of slots) for (const x of sl.sounds)
    expects.push({ id: x.id, score: x.score, beat: sl.beat, madeAt, offset: sl.slot - madeAt });
}
// Prior per sound: newest guesses count most; nearer slots count a bit more than far ones
function prior(now: number): Map<string, { p: number; beat: string }> {
  const out = new Map<string, { p: number; beat: string }>();
  for (const e of expects) {
    const age = Math.max(0, now - 1 - e.madeAt);                     // 0 = newest prediction
    const p = e.score * [1, 0.8, 0.6][Math.min(age, 2)] * [1, 1, 0.9, 0.8, 0.7, 0.6][Math.min(e.offset, 5)];
    if (p > (out.get(e.id)?.p ?? 0)) out.set(e.id, { p, beat: e.beat });
  }
  return out;
}
// The expected event happened: stop expecting it
// (kept briefly as "fulfilled", so the rest of the same sentence still counts as matching the prediction)
let fulfilled: (Expect & { at: number })[] = [];
const consume = (id: string) => {
  fulfilled = [...fulfilled.filter(f => Date.now() - f.at < 15_000), ...expects.filter(e => e.id === id).map(e => ({ ...e, at: Date.now() }))];
  expects = expects.filter(e => e.id !== id);
};

// =====================================================================
// 4. FAST LOOP — score every sound against the words, pick one or stay silent
// =====================================================================
const BASE_TAU = { subtle: 0.8, normal: 0.65, expressive: 0.45 }; // min p(play) to fire
let TAU = BASE_TAU[STORY.density]; // silence threshold; set after setup, nudged by /skip and /good
const lastPlayed = new Map<string, number>();
// "dings" → "ding", "roared" → "roar"; short words keep their letters ("ding" must not become "d", "ring" not "r")
// irregular past tenses that name sounds ("the phone rang" must match "phone rings")
const IRREGULAR: Record<string, string> = {
  rang: "ring", rung: "ring", broke: "break", broken: "break", shot: "shoot", fell: "fall", fallen: "fall", blew: "blow", blown: "blow",
  threw: "throw", thrown: "throw", struck: "strike", sang: "sing", sung: "sing", shook: "shake", shaken: "shake", froze: "freeze",
  tore: "tear", torn: "tear", woke: "wake", spoke: "speak", swung: "swing", drove: "drive", rode: "ride", ran: "run", hit: "hit",
  bit: "bite", burst: "burst", flew: "fly", dug: "dig", hung: "hang", stuck: "stick", sank: "sink", sprang: "spring", leapt: "leap", crept: "creep", wept: "weep",
};
const stem = (w: string) => {
  const c = w.toLowerCase().replace(/[^a-z]/g, "");
  let r = IRREGULAR[c] ?? c;
  if (!IRREGULAR[c]) {
    if (/(ing|(?<!e)ed)$/.test(r)) {
      r = r.replace(/(ing|ed)$/, "");
      if (/([bdgmnprt])\1$/.test(r)) r = r.slice(0, -1);        // slammed → slam, stopped → stop, running → run
    } else if (/(ss|x|z|ch|sh)es$/.test(r)) r = r.slice(0, -2); // glasses → glass, crashes → crash
    else if (/[^s]s$/.test(r)) r = r.slice(0, -1);              // barks → bark (but hiss stays hiss)
  }
  if (r.length > 3 && r.endsWith("e")) r = r.slice(0, -1);       // chime / chimed / chimes all → chim
  return r.length >= 3 ? r : c;
};

// A tag matches if its word (or every word of a multi-word tag, in order) is in the sentence
const norm = (t: string) => " " + t.split(/\s+/).map(stem).filter(Boolean).join(" ") + " ";
const tagHit = (said: string, tag: string) => said.includes(norm(tag));

// LEARNED SCORER (online logistic regression) — p(play) = sigmoid(w · x)
// Labels come from Claude's hindsight (which sound the last sentence deserved) and from /good, /skip.
// Every correct call pushes the weights toward what worked; weights.json carries it to the next run.
const FEATS = ["bias", "claude", "words", "keyword", "tension fit", "on-topic", "repeat", "need", "context fit"];
let W = [-3.0, 2.5, 2.5, 1.2, 0.5, 1.0, -3.0, 1.2, 1.5];
const WEIGHTS_FILE = "weights.json";
if (existsSync(WEIGHTS_FILE)) try {
  const saved = JSON.parse(readFileSync(WEIGHTS_FILE, "utf8")).W;
  if (Array.isArray(saved) && saved.length === W.length) W = saved; // older files with other features are ignored
  W[0] = Math.max(-3, Math.min(1, W[0])); // a cautious past run must not leave the scorer nearly silent
} catch { }
const saveWeights = () => writeFileSync(WEIGHTS_FILE, JSON.stringify({ W, feats: FEATS, updated: new Date().toISOString() }, null, 2));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dotW = (x: number[]) => x.reduce((a, v, i) => a + v * W[i], 0);
const learnStats = { agree: 0, total: 0, updates: 0 };

function learn(x: number[], y: number, weight = 1, lr = 0.15) { // small steps: one odd sentence shouldn't swing the model
  const err = y - sigmoid(dotW(x));
  W = W.map((w, i) => w + lr * weight * err * x[i]);
  W[0] = Math.max(-3, Math.min(1, W[0])); // bias floor: learning can't push the system into playing nothing
  learnStats.updates++;
}

// LIVE KEYWORDS — the important words shift as the story moves. Claude refreshes this list every sentence;
// the user's setup keywords stay as a baseline.
let liveWords: { word: string; sound: string }[] = [];
function setLiveWords(list: { word: string; sound: string }[]) {
  const before = liveWords.map(l => l.word).join(",");
  liveWords = (list ?? []).filter(l => l.word?.trim());
  if (liveWords.map(l => l.word).join(",") !== before)
    say(C.slow, "KEYWORDS", `now listening for: ${liveWords.map(l => `${l.word}→${l.sound}`).join(", ") || "(nothing specific)"}`);
}
const liveFor = (id: string) => liveWords.filter(l => l.sound === id).map(l => l.word);

// WHEN: the word in the sentence the sound should land on (first match), as a position in the phrase
function triggerWord(text: string, s: Sound): { word: string; pos: number } | null {
  const ws = text.split(/\s+/);
  const targets = [...s.tags, ...liveFor(s.id)];
  for (let k = 0; k < ws.length; k++)
    for (const t of targets) {
      const tw = t.split(/\s+/);
      if (tw.every((w, j) => stem(ws[k + j] ?? "") === stem(w))) return { word: ws.slice(k, k + tw.length).join(" "), pos: (k + tw.length) / ws.length };
    }
  return null;
}

// CONTEXT FIT — is this sentence what Claude predicted / does it follow the story, or a random insert?
// Uses a small local embedding model (meaning, not just words); falls back to word overlap if unavailable.
let embedder: any = null;
async function loadEmbedder() {
  try {
    const { pipeline } = await import("@huggingface/transformers");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  } catch { embedder = null; }
}
const vecCache = new Map<string, Float32Array>();
async function vec(t: string): Promise<Float32Array | null> {
  if (!embedder) return null;
  if (!vecCache.has(t)) vecCache.set(t, (await embedder(t, { pooling: "mean", normalize: true })).data as Float32Array);
  return vecCache.get(t)!;
}
const STOP = new Set("a an the and or but so to of in on at for with was were is are be been it its this that these those i we you he she they me my our your his her them then there just like really very um uh yeah okay".split(" "));
const content = (t: string) => new Set(t.split(/\s+/).map(stem).filter(w => w.length > 2 && !STOP.has(w)));
async function similarity(a: string, b: string): Promise<number> {
  const [va, vb] = await Promise.all([vec(a), vec(b)]);
  if (va && vb) { let d = 0; for (let k = 0; k < va.length; k++) d += va[k] * vb[k]; return d; }
  const A = content(a), B = content(b);
  if (!A.size || !B.size) return 0;
  return [...A].filter(w => B.has(w)).length / Math.sqrt(A.size * B.size);
}
// Thresholds differ: embeddings score meaning (0..1), word overlap is much sparser
const FIT = () => (embedder ? { high: 0.45, low: 0.25 } : { high: 0.3, low: 0.1 });

// fitPrediction: best match between the sentence and the beats Claude predicted for the next moments
// fitStory: match with where the story is (focus + scene + last sentences)
async function contextFit(text: string, recentLines: string[]) {
  const beats = [...new Set([...expects, ...fulfilled.filter(f => Date.now() - f.at < 15_000)].map(e => e.beat).filter(Boolean))];
  let fitPrediction = 0, bestBeat = "";
  for (const b of beats) { const v = await similarity(text, b); if (v > fitPrediction) { fitPrediction = v; bestBeat = b; } }
  const storyCtx = [state?.focus, state?.scene, ...recentLines.slice(-3).map(l => l.replace(/^\[\d+\] /, ""))].filter(Boolean).join(". ");
  const fitStory = storyCtx ? await similarity(text, storyCtx) : 0.5;
  const f = FIT();
  const insert = !!state && fitPrediction < f.low && fitStory < f.low;
  const confirmed = fitPrediction >= f.high;
  return { fitPrediction, fitStory, bestBeat, insert, confirmed };
}

// ARBITER — when several sounds match one sentence, Claude decides which (up to 2), in what order, on which word.
async function arbitrate(text: string, cands: { id: string; p: number; word: string }[], ctx: { recent: string[]; beats: string[] }): Promise<{ plays: { id: string; word: string }[]; reason: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-5-5", max_tokens: 250,
        tools: [{
          name: "choose", description: "Pick the sound(s) for this sentence", input_schema: {
            type: "object", required: ["plays", "reason"], properties: {
              plays: {
                type: "array", maxItems: 2, items: {
                  type: "object", required: ["id", "word"], properties: {
                    id: { type: "string", enum: cands.map(c => c.id) }, word: { type: "string", description: "word in the sentence the sound lands on" }
                  }
                }
              },
              reason: { type: "string" }
            }
          }
        }],
        tool_choice: { type: "tool", name: "choose" },
        messages: [{
          role: "user", content: `Live story sound design. Story now: ${state?.scene ?? "starting"} (tension ${f2(state?.tension ?? 0.3)}, ${mix.arc}).
Story so far (last sentences): ${ctx.recent.slice(-4).join(" / ") || "(start)"}
What you predicted would come next: ${ctx.beats.slice(0, 3).join(" / ") || "(nothing yet)"}
Sentence just spoken: "${text}"
First check: does this sentence actually continue THIS story, or is it a random insert that only shares a word? If it doesn't continue the story, choose nothing.
Candidate sounds: ${cands.map(c => `${c.id} = ${CUES.find(s => s.id === c.id)?.description?.slice(0, 80) || c.id} (on "${c.word}", fast score ${f2(c.p)})`).join("; ")}.
Pick 0, 1 or 2 of them, in the order they should play, each on the word it should land on. Prefer one strong sound over two weak ones.
Pick a sound ONLY if the event it represents is itself happening or has just happened in this sentence. Do NOT pick it because it was predicted, because its noun is the subject of a sentence about something silent, or because it merely relates to the topic. When unsure, choose silence. Empty list = silence.` }],
      }),
    });
    const data: any = await res.json();
    return data.content?.find((b: any) => b.type === "tool_use")?.input ?? null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// MEANING MATCH: sentence vs each sound's event description (only with the local model)
async function soundMeaning(text: string): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  if (!embedder) return m;
  for (const s of CUES) if (s.description) m.set(s.id, await similarity(text, s.description));
  return m;
}

function decide(text: string, now: number, tension: number, fit: number, meaning = new Map<string, number>()) {
  const said = norm(text);
  const words = new Set(text.split(/\s+/).map(stem));
  const pr = prior(now);
  const onTopic = state?.on_topic ?? 0.7;
  const ranked = CUES.map(s => {
    // How strongly the words say this sound is happening: a single word 0.5, a phrase 0.75, each extra hit +0.25,
    // or the meaning of the sentence matching the sound's description (works for wordings nobody listed)
    // Only EVENT words count as word evidence: a phrase, a noise (bark, ring, crash) or one of the sound's instant phrases.
    // A bare object/place tag ("seat", "cup", "book") is a mention, not the sound happening, so it can't fire a sound by itself.
    const hits = s.tags.filter(t => tagHit(said, t) && (t.includes(" ") || EVENT_WORD.test(t.toLowerCase()) || (s.instant ?? []).includes(t.toLowerCase())));
    const tagShare = !hits.length ? 0 : Math.min(1, (hits.some(t => t.includes(" ")) ? 0.75 : 0.5) + 0.25 * (hits.length - 1));
    const sem = meaning.get(s.id) ?? 0;
    const semScore = sem >= 0.38 ? Math.min(1, sem) : 0;
    const setupKey = STORY.keywords.some(k => words.has(stem(k)) && s.tags.some(t => stem(t) === stem(k)));
    const liveKey = liveFor(s.id).some(w => tagHit(said, w)); // a word Claude flagged as important right now
    const keyword = setupKey || liveKey ? 1 : 0;
    // A word Claude told us to listen for right now is strong evidence for its sound
    const overlap = Math.max(tagShare, semScore, liveKey ? 0.75 : 0);
    const pri = pr.get(s.id)?.p ?? 0;
    const repeat = Date.now() - (lastPlayed.get(s.id) ?? 0) < 90_000 ? 1 : 0;
    const x = [1, pri, overlap, keyword, 1 - Math.abs(tension - s.intensity), onTopic, repeat, state?.sound_need ?? 0.5, fit];
    // Any word match is evidence. A WEAK one (one generic word, nothing Claude expected, e.g. "ghost stories")
    // is not trusted on its own: Claude is asked whether it's a real event or just a mention.
    // a sound Claude strongly expects, while the speech follows the story, counts as evidence even without its trigger word
    const evidence = overlap > 0 || keyword > 0 || (pri >= 0.6 && fit >= FIT().low);
    // one plain word, nothing Claude expected, meaning doesn't back it up → could be a mention
    const weak = evidence && hits.length <= 1 && !hits.some(t => t.includes(" ")) && pri < 0.2 && !liveKey && semScore === 0;
    return { s, x, p: sigmoid(dotW(x)), pri, overlap, evidence, weak, beat: pr.get(s.id)?.beat ?? "", live: liveKey };
  }).sort((a, b) => b.p - a.p);
  const best = ranked.find(r => r.evidence);
  return { ranked, best: best && best.p > TAU ? best : null as typeof best | null };
}

// Which spoken words map to sounds in the library / to the user's keywords
function mapWords(text: string): string {
  const out: string[] = [];
  for (const w of new Set(text.split(/\s+/).map(stem).filter(Boolean))) {
    const sounds = CUES.filter(s => s.tags.some(t => !t.includes(" ") && stem(t) === w)).map(s => s.id);
    const isKey = STORY.keywords.some(k => stem(k) === w);
    if (sounds.length || isKey) out.push(`${w}→${sounds.join("/") || "(keyword, no sound)"}${isKey && sounds.length ? " ★" : ""}`);
  }
  for (const s of CUES) for (const t of s.tags) if (t.includes(" ") && tagHit(norm(text), t)) out.push(`"${t}"→${s.id}`);
  for (const l of liveWords) if (tagHit(norm(text), l.word)) out.push(`"${l.word}"→${l.sound} (live)`);
  return out.length ? out.join("  ") : "no words map to the library";
}

// =====================================================================
// 5. WHOLE-SPEECH PLAN + MIX — keeps sound consistent from start to end
// =====================================================================
// Once at the start, Claude reads the summary and plans the shape of the whole talk:
// how loud the music sits in each part, how many sounds each part may use, and where stingers are allowed.
// After that, every sentence follows this plan, so the speech feels like one designed piece.
type Arc = "setup" | "rising" | "climax" | "falling" | "resolution";
type Section = { music: number; ambience: number; sfxBudget: number; stingers: boolean; gap: number };
const ARCS: Arc[] = ["setup", "rising", "climax", "falling", "resolution"];

// Fallback if the plan call fails (a slow-build story)
let PLAN: Record<Arc, Section> = {
  setup: { music: 0.25, ambience: 0.5, sfxBudget: 1, stingers: false, gap: 3 },
  rising: { music: 0.45, ambience: 0.4, sfxBudget: 2, stingers: false, gap: 2 },
  climax: { music: 0.8, ambience: 0.2, sfxBudget: 2, stingers: true, gap: 1 },
  falling: { music: 0.4, ambience: 0.4, sfxBudget: 1, stingers: false, gap: 2 },
  resolution: { music: 0.2, ambience: 0.3, sfxBudget: 0, stingers: false, gap: 3 },
};

async function planWholeSpeech(shift?: string): Promise<void> {
  const section = {
    type: "object", required: ["music", "ambience", "sfxBudget", "stingers", "gap"], properties: {
      music: { type: "number", description: "background music level 0..1 in this part" },
      ambience: { type: "number", description: "ambience level 0..1" },
      sfxBudget: { type: "integer", description: "max sound effects in this part" },
      stingers: { type: "boolean", description: "allow dramatic stingers (riser, hit) here" },
      gap: { type: "integer", description: "min sentences between two sound effects" }
    }
  };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-5-5", max_tokens: 1000,
        tools: [{
          name: "plan", description: "Sound plan for each part of the talk",
          input_schema: { type: "object", required: ARCS, properties: Object.fromEntries(ARCS.map(a => [a, section])) }
        }],
        tool_choice: { type: "tool", name: "plan" },
        messages: [{
          role: "user", content: `You are the sound designer for a live talk. Plan the sound for the WHOLE talk so it stays consistent and builds well.
Summary: "${storyNow()}". Tone: ${STORY.tone}. Density: ${STORY.density}.${shift ? `
The talk has shifted: its main thread is now "${shift}" (currently in the ${mix.arc} part). Re-plan for where it is going from here.` : ""}
For each part (setup, rising, climax, falling, resolution) set music level, ambience level, sound budget, whether stingers are allowed, and the min gap.
Music must stay under the voice (never above 0.85). Save the biggest moments for the climax. Fewer sounds is better than too many.` }],
      }),
    });
    const data: any = await res.json();
    const out = data.content?.find((b: any) => b.type === "tool_use")?.input;
    // Accept each part only if it came back complete; otherwise keep the previous values for that part
    if (out) for (const a of ARCS) {
      const sec = out[a];
      if (sec && ["music", "ambience", "sfxBudget", "gap"].every(k => typeof sec[k] === "number")) PLAN[a] = { ...sec, stingers: !!sec.stingers };
    }
  } catch { /* keep fallback */ }
}

// Live mix state — smoothed, so levels glide instead of jumping
const mix = { music: 0.5, ambience: 0.4, arc: "setup" as Arc, usedInArc: 0, sentencesSinceSfx: 99 };
const MAX_STEP = 0.16; // max level change per sentence (raise for faster swells, lower for smoother)
const glide = (from: number, to: number) => from + Math.max(-MAX_STEP, Math.min(MAX_STEP, to - from));
type Row = {
  i: number; text: string; arc: Arc; tension: number; music: number; sound: string; at: string;
  label: string; onTopic?: number; claudeMs?: number; hindsight?: string; thread?: string;
  expected: string; outcome: "hit" | "surprise" | "quiet" | "no prediction"
};
const timeline: Row[] = [];
let testLabel = "unlabeled"; // set with /test 80

// Called every sentence: move levels toward the plan for this part of the story
function updateMix(tension: number) {
  const sec = PLAN[mix.arc];
  // tension pushes music up inside the part's range; when effects aren't needed, music carries a bit more
  // music swings with tension (calm = softer, tense = louder) but never disappears; ceiling 0.6 keeps it under the effects
  const swing = 0.5 + 0.5 * Math.pow(Math.max(0, Math.min(1, tension)), 1.2);
  // floor 0.45: the plan's quiet parts (0.25 × calm) used to sit ~28 dB down and vanish under the voice ducking
  const target = Math.min(0.8, 0.45 + 0.45 * (sec.music * swing * 1.2 + 0.06 * (1 - (state?.sound_need ?? 0.5))));
  mix.music = glide(mix.music, target);
  // predict.ts only states the INTENT (plan levels); the mixer (player.ts) keeps the ambience under the music
  mix.ambience = glide(mix.ambience, sec.ambience);
  setLevel("music", mix.music); setLevel("ambience", mix.ambience); // restarts a bed only when it moved noticeably
}

// Arc moves forward only (no jumping back from climax to setup on one odd sentence)
function setArc(arc: string) {
  const next = arc as Arc;
  if (ARCS.indexOf(next) > ARCS.indexOf(mix.arc)) {
    say(C.music, "PLAN", `story moved ${mix.arc} → ${next}: music ~${f2(PLAN[next].music)}, ${budget(next)} sounds, stingers ${PLAN[next].stingers ? "on" : "off"}`);
    mix.arc = next; mix.usedInArc = 0;
  }
}

// Does the plan allow a sound right now? RETURNS a reason if not
// Plan budgets are for a ~5 min talk; a longer talk gets more sounds, a shorter one fewer
// Every part of the talk gets a few sounds even in a short talk (a 1-min talk used to allow just 1 per part)
const minBudget = { subtle: 1, normal: 2, expressive: 3 };
const budget = (arc: Arc) => PLAN[arc].sfxBudget === 0 && STORY.density === "subtle" ? 0
  : Math.max(minBudget[STORY.density], Math.round((PLAN[arc].sfxBudget * clock.estMin) / 5));
// Gap is capped by density, so a cautious plan can't silence a short talk
const gapCap = { subtle: 3, normal: 1, expressive: 0 }; // sentences between sounds (0 = back-to-back allowed)
const gap = (arc: Arc) => Math.min(PLAN[arc].gap, gapCap[STORY.density]);

function planBlocks(s: Sound): string | null {
  const sec = PLAN[mix.arc];
  // a moment that strongly needs sound (need ≥ 0.8) may go one over the part's budget
  const extra = (state?.sound_need ?? 0) >= 0.8 ? 1 : 0;
  if (mix.usedInArc >= budget(mix.arc) + extra) return `budget for ${mix.arc} used (${budget(mix.arc)} for a ${clock.estMin} min talk)`;
  if (mix.sentencesSinceSfx < gap(mix.arc)) return `too soon (gap ${gap(mix.arc)} sentences in ${mix.arc})`;
  // Stingers wait for the climax — unless the story is clearly peaking right now (the speech wins over the plan)
  if (s.role === "stinger" && !sec.stingers && (state?.tension ?? 0) < 0.75) return `stingers saved for later (not in ${mix.arc})`;
  return null;
}

const bar = (x: number) => "█".repeat(Math.round(x * 10)).padEnd(10, "·");

// =====================================================================
// 6. MAIN — wire it together and print
// =====================================================================
const C = { slow: "\x1b[35m", fast: "\x1b[90m", play: "\x1b[32m", music: "\x1b[36m", heard: "\x1b[1m", off: "\x1b[0m" };
// The console shows the useful lines; --verbose adds the scoring internals
const HIDDEN = new Set(["MAP", "FIT", "FAST", "LATENCY", "LEARN", "EVAL", "KEYWORDS", "NEED", "SCENE", "TIME", "MIX", "STREAM", "ASK", "SILENCE", "CLAUDE"]);
const say = (color: string, tag: string, msg: string) => { if (!process.argv.includes("--verbose") && HIDDEN.has(tag)) return; console.log(`${color}[${tag}]${C.off} ${msg}`); };
const f2 = (x: number) => x.toFixed(2);

let index = -1, state: State | null = null, lastTracked = -1;
const recent: string[] = [];
const layer = { music: { now: "", vote: "", n: 0 }, ambience: { now: "", vote: "", n: 0 } };

function vote(name: "music" | "ambience", value: string) {
  const L = layer[name];
  // "none": nothing in the library fits the place the speaker is in → the ambience fades out (2 votes, like any switch)
  if (name === "ambience" && value === "none") {
    if (!L.now) { L.vote = ""; L.n = 0; return; }
    L.n = value === L.vote ? L.n + 1 : 1; L.vote = value;
    if (L.n < 2) return say(C.music, "MUSIC", "ambience leaning none (1/2): nothing in the library fits this place");
    L.now = ""; L.vote = ""; L.n = 0;
    say(C.music, "MUSIC", "ambience → none (no bed in the library fits where the story is)");
    setLoop("ambience", undefined, 0);
    return;
  }
  if (!value || value === L.now) { L.vote = ""; L.n = 0; return; }
  L.n = value === L.vote ? L.n + 1 : 1; L.vote = value;
  // nothing playing yet → start now (never leave the talk without music); later switches need 2 votes
  if (L.n < 2 && L.now) return say(C.music, "MUSIC", `${name} leaning ${value} (1/2)`);
  let found = LIBRARY.find(s => (name === "music" ? s.mood : s.setting) === value);
  // no file for that mood yet: with NO music playing, start any music that has a file (never a talk without music);
  // otherwise keep what's playing instead of "switching" to nothing
  if (!found?.files?.length && name === "music" && !L.now) {
    found = LIBRARY.find(s => s.role === "music" && s.files?.length);
    if (found) value = found.mood ?? value;
  }
  if (!found?.files?.length) { L.vote = ""; L.n = 0; return; }
  const sound = found?.id;
  const verb = L.now ? "SWITCH" : "START";
  L.now = value; L.vote = ""; L.n = 0;
  say(C.music, "MUSIC", `${verb} ${name} → ${value} (${sound}${found?.files?.length ? ", playing" : ""})`);
  startBed(name, found);
}

const FILLER = new Set(["um", "uh", "so", "yeah", "like", "okay", "and", "the", "a", "i"]);
const meaningful = (t: string) => { const w = t.toLowerCase().split(/\s+/).filter(Boolean); return w.length >= 4 && w.filter(x => !FILLER.has(x)).length >= 3; };

// "/time 8" → new estimate; the next Claude call and the sound budgets use it right away
function setEstimate(min: number) {
  if (!(min > 0)) return say(C.music, "TIME", "usage: /time 8   (minutes)");
  const old = clock.estMin;
  clock.estMin = min;
  say(C.music, "TIME", `estimate ${old} → ${min} min. Now ${clockText()}, time suggests "${arcByTime()}". ` +
    `Budgets now: ${ARCS.map(a => `${a} ${budget(a)}`).join(", ")}`);
}

let overtimeWarned = false;
let cfInsert = false;
const pendingLabels = new Map<number, { cands: { id: string; x: number[] }[]; played: string; anticipated: string[] }>();
let lastSoundX: number[] = [];
let lastDisagree = "";
// Current bar for p(play): off-topic raises it, unrelated speech pauses effects, sound need moves it
function currentTau(now = index + 1) {
  const onTopic = state?.on_topic ?? 1;
  // sound_need describes the LAST sentence; if Claude strongly expects an event right now, that need counts too
  const topPrior = Math.max(0, ...[...prior(now).values()].map(v => v.p));
  const need = Math.max(state?.sound_need ?? 0.5, topPrior >= 0.6 ? topPrior : 0);
  // dry spell: after ~20 s with no sound the bar slowly drops, so the system can't settle into silence
  const dry = Math.min(0.2, Math.max(0, Date.now() - lastAnyPlay - 20_000) / 100_000);
  const tauNow = onTopic < 0.3 ? Infinity
    : Math.max(0.3, Math.min(0.95, TAU + (onTopic < 0.5 ? 0.3 * (0.5 - onTopic) * 2 : 0) + 0.4 * (0.5 - need) - dry));
  return { onTopic, need, tauNow };
}

type Cand = { s: Sound; x: number[]; p: number; live: boolean; beat: string };
let lastAnyPlay = Date.now();
// HOW SHOULD THIS SOUND BE TREATED? Two inputs, kept apart:
//   · the SOUND (metadata, written once by the planner): its story weight (`emphasis`) and its own character (`softness`)
//   · the SCENE (live): tension, where we are in the arc, how much sound the moment needs, whether Claude expected it
// Output is a treatment, not just a volume: `liftDb` relative to the music (negative = tucked UNDER it, 0 = merged,
// positive = standing out), a low-pass + room amount that soften it into the scene, and an attack time.
// A pivotal sound in a calm, reflective scene is therefore softened, not shouted; a sharp sound in a tense one is lifted.
const emphasisOf = (s: Sound) => s.emphasis ?? (s.role === "stinger" ? 0.85 : s.id.split("_").some(t => EVENT_WORD.test(t)) ? 0.7 : 0.35);
// The planner's softness is a guess from the sound's NAME; the clip that was actually fetched can differ (a "door" clip may
// be a slam or a creak). So it is blended with softness MEASURED from that clip.
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
// Measured sharpness is about TRANSIENTS, not brightness: a discrete hit (the loudest 10 ms far above the clip's typical 10 ms,
// fast rise) is sharp; a steady texture (flat envelope: rain, crowd, hum, wind) is gentle however hissy it is. Brightness only
// nudges it. This is a property of the audio, so it holds for any genre or sound the scraper returns.
function measuredSoftness(s: Sound): number | undefined {
  const p = soundProfile(s.files?.[0]);
  if (!p || p.seconds < 0.15) return undefined; // too short to measure reliably → rely on the planner's softness
  const n = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));
  const impulse = n(p.impulseDb, 3, 14), rise = 1 - n(p.riseMs, 10, 150), bright = n(p.zcrHz, 1500, 5000);
  return 1 - impulse * (0.55 + 0.3 * rise + 0.15 * bright);
}
const softnessOf = (s: Sound) => {
  const m = measuredSoftness(s);
  return m !== undefined && s.softness !== undefined ? 0.6 * m + 0.4 * s.softness : m ?? s.softness ?? (s.id.split("_").some(t => EVENT_WORD.test(t)) ? 0.3 : 0.5);
};
const ARC_ENERGY: Record<string, number> = { setup: 0.3, rising: 0.6, climax: 1, falling: 0.4, resolution: 0.2 };
function treatment(r: Cand, volScale = 1) {
  const need = state?.sound_need ?? 0.5;
  const sceneEnergy = 0.6 * (state?.tension ?? 0.3) + 0.4 * (ARC_ENERGY[mix.arc] ?? 0.4);
  const expected = r.live || r.beat || fitsNow?.has(r.s.id) ? 1 : 0;
  // presence: how far this sound should come forward right now (0 = sit inside the music, 1 = clearly in front)
  let presence = 0.45 * emphasisOf(r.s) + 0.4 * sceneEnergy + 0.15 * expected + 0.15 * (need - 0.5) + 0.12 * (r.s.intensity - 0.5) - (1 - volScale);
  // BIG PICTURE FIRST: Claude's scene mix (fx_blend) decides how effects sit in this scene; the sound's own metadata
  // (emphasis, intensity) only moves it within that
  if (typeof state?.fx_blend === "number") presence = 0.6 * Math.max(0, Math.min(1, state.fx_blend)) + 0.4 * presence;
  presence = Math.max(0, Math.min(1, presence));
  // softening grows when the sound should sit back or is gentle by nature
  const soften = Math.max(0, Math.min(1, 0.55 * (1 - presence) + 0.45 * softnessOf(r.s)));
  // softening never goes below 4 kHz: at 2.5 kHz a sound under a live voice turned into a dull thud nobody noticed
  const lowpassHz = soften < 0.3 ? undefined : Math.round(Math.exp(Math.log(16000) + (Math.log(4000) - Math.log(16000)) * ((soften - 0.3) / 0.7)));
  return {
    presence, soften, lowpassHz,
    // +1 … +8 dB over the music, from the planner's emphasis + the scene: a passing detail sits just above the music
    // (blends in), a pivotal hit stands out. Was +2 … +12, which with the ducking left effects ~15-20 dB over the music:
    // every sound popped out on its own instead of merging. Never below +1: under the voice it would vanish.
    liftDb: 1 + 7 * presence,
    wet: 0.5 + 0.8 * soften,
    // fades: the planner decided how this sound starts (attack) and ends (tail); the scene's softening is blended in so a
    // sound that has to sit back also eases in and dissolves out, and a hard hit in a tense scene keeps its natural edge
    attackMs: Math.round(r.s.attack !== undefined ? 0.65 * (8 + r.s.attack ** 2 * 600) + 0.35 * (8 + soften * soften * 120) : 8 + soften * soften * 120),
    releaseMs: Math.round(r.s.tail !== undefined ? 0.65 * (120 + r.s.tail ** 2 * 2200) + 0.35 * (120 + soften * soften * 1400) : 120 + soften * soften * 1400),
  };
}
function playSound(r: Cand, word: string, text: string, tag = "PLAY", volScale = 1) {
  lastSound = r.s.id; lastSoundX = r.x; lastAnyPlay = Date.now();
  lastPlayed.set(r.s.id, Date.now());
  consume(r.s.id);
  mix.usedInArc++; mix.sentencesSinceSfx = 0;
  const tr = treatment(r, volScale);
  const tw = triggerWord(text, r.s);
  const when = word ? `on "${word}"${tw && tag === "PLAY" ? ` (~${Math.round(tw.pos * 100)}% into the phrase)` : ""}` : "at phrase end";
  playOnce(fileOf(r.s), 1, { role: r.s.role, liftDb: tr.liftDb, attackMs: tr.attackMs, releaseMs: tr.releaseMs, maxS: r.s.lengthS ? r.s.lengthS * 1.25 : undefined, lowpassHz: tr.lowpassHz, wet: tr.wet });
  say(C.play, tag, `${r.s.id}${r.s.files?.length ? " ♪" : ""} ${when}, ${tr.liftDb >= 4 ? "in front" : tr.liftDb >= 0 ? "merged" : "tucked under"} ${tr.liftDb >= 0 ? "+" : ""}${tr.liftDb.toFixed(1)} dB vs music, soften ${f2(tr.soften)}${tr.lowpassHz ? ` (low-pass ${tr.lowpassHz} Hz)` : ""}, room ${f2(tr.wet)}, fade in ${tr.attackMs} / out ${tr.releaseMs} ms  (p ${f2(r.p)}${r.live ? ", live keyword" : ""}${r.beat ? `, Claude expected: "${r.beat}"` : ""}, ${mix.usedInArc}/${budget(mix.arc)} in ${mix.arc})`);
}

// INSTANT PATH (pure string matching, ~1 ms, no AI and no embeddings): runs on EVERY partial transcript.
// Fires when the newest words contain
//   · an ARMED phrase (Claude listed it ahead of time as "will happen soon": pre-approved), or
//   · an INSTANT phrase that names the sound itself ("dog barks", "gunshot"; library prep writes these once).
// A bare noun ("my dog", "the door") is never instant. Only the last 6 words are scanned, so a sound is never
// triggered by something said long ago: late is worse than silent.
const instantGate = { last: 0, prevTail: [] as string[] };
const REPEAT_MS = 15_000; // the same effect again within 15 s sounds like a glitch
const usedWord = new Map<string, number>(); // stemmed trigger word → when a sound last fired on it
const SMALL = new Set(["the", "a", "an", "my", "his", "her", "their", "our", "your", "its", "went", "off", "up", "on", "of", "to", "and", "is", "was", "are"]);
// Claude's big-picture list (refreshed every sentence): sounds that genuinely enhance the story right now.
// null until the first update (the library was built for this theme, so everything is allowed until then).
let fitsNow: Set<string> | null = null;
function instantScan(text: string, lagMs: number, arrived: number): boolean {
  const now = Date.now();
  if (now - instantGate.last < 1500) return false; // sounds don't pile up ("a gunshot cracked" = one event, not gunshot + glass crack)
  // LOOSER MATCHING: the last 8 words; a phrase's words may be up to 4 words apart, in any order
  // ("engines roared" ~ "the engines are already roaring", "doorbell rang" ~ "the doorbell finally rang")
  const tailWords = text.split(/\s+/).slice(-8).map(stem).filter(Boolean);
  const near = (phrase: string) => {
    const need = phrase.split(/\s+/).map(stem).filter(w => w && !SMALL.has(w));
    if (!need.length) return false;
    for (let end = tailWords.length - 1; end >= 0; end--) {
      if (!need.includes(tailWords[end])) continue;
      const win = tailWords.slice(Math.max(0, end - need.length - 4), end + 1);
      if (need.every(w => win.includes(w))) return true;
    }
    return false;
  };
  const hits: { s: Sound; x: number[]; pr: any; armed?: string; hitPhrase: string; hitWords: string[]; rank: number }[] = [];
  for (const s of CUES) {
    if (early.played.some(e => e.id === s.id) || now - (lastPlayed.get(s.id) ?? 0) < REPEAT_MS) continue;
    // a single ARMED word must itself be a noise ("thunder", "bang") or one of the sound's instant phrases; a bare
    // object ("elevator", "door") can be mentioned without the sound ("the elevator at my gym is broken")
    const armable = (w: string) => w.trim().split(/\s+/).length > 1 || EVENT_WORD.test(w.trim().toLowerCase()) || (s.instant ?? []).includes(w.trim().toLowerCase());
    const armed = liveFor(s.id).find(w => armable(w) && near(w));
    const named = armed ? undefined : (s.instant ?? []).find(p => near(p));
    // Only a SINGLE word needs the big picture's blessing ("thunder" in "the thunder in that movie"); a phrase that
    // names the sound happening ("thunder crashed", "doorbell rang") fires on its own. Clearly unrelated speech
    // (Claude's on-topic < 0.2) gets nothing it didn't arm.
    const single = !!named && named.trim().split(/\s+/).length === 1;
    if (named && (state?.on_topic ?? 1) < 0.2) continue;
    // a single word ("ring") needs Claude's big-picture OK, OR another word of the sound itself right next to it
    // ("the PHONE rang" → phone_ring yes; "the castle bells rang" → phone_ring no)
    if (single) {
      const w0 = stem(named!.trim());
      const ownOther = [...s.id.split("_"), ...(s.description ?? "").split(/\s+/)].map(stem).filter(w => w && w !== w0 && !SMALL.has(w));
      const backed = ownOther.some(w => tailWords.includes(w));
      if ((!backed && (!fitsNow || !fitsNow.has(s.id))) || (state?.sound_need ?? 0.5) < 0.2) continue;
    }
    if (!armed && !named) continue;
    // ONE SPOKEN WORD = ONE SOUND: "glass shattered" must not fire both glass_break and plate_crash
    const hitWords = ((armed ?? named)!).split(/\s+/).map(stem).filter(w => w && !SMALL.has(w));
    if (hitWords.some(w => now - (usedWord.get(w) ?? 0) < 4000)) continue;
    if (s.role === "stinger" && planBlocks(s)) continue; // stingers still wait for their moment
    const pr = prior(index + 1).get(s.id);
    const x = [1, pr?.p ?? 0, 1, 1, 1 - Math.abs((state?.tension ?? 0.3) - s.intensity), state?.on_topic ?? 0.7, 0, state?.sound_need ?? 0.5, 1];
    const hitPhrase = (armed ?? named)!;
    // OWNERSHIP: is the heard word part of what this sound IS (its own id / planner description), not just something Claude
    // armed or a scraped clip's tag? ("creak" belongs to floorboard_creak, not to a door slam whose clip happens to carry that tag)
    const own = new Set([...s.id.split("_"), ...(s.description ?? "").split(/\s+/)].map(stem).filter(Boolean));
    const owns = hitWords.some(w => own.has(w)) ? 1 : 0;
    const rank = (armed ? 3 : 0) + owns * 3.5 + (pr?.p ?? 0) * 2 + (fitsNow?.has(s.id) ? 1 : 0) + Math.min(2, hitPhrase.trim().split(/\s+/).length) * 0.3;
    hits.push({ s, x, pr, armed, hitPhrase, hitWords, rank });
  }
  const lastWord = tailWords[tailWords.length - 1];
  const prevTail = instantGate.prevTail;
  instantGate.prevTail = tailWords;
  const stable = hits.filter(h => h.hitWords.length > 1 || h.hitWords[0] !== lastWord || prevTail.includes(h.hitWords[0]));
  if (!stable.length) return false;
  const { s, x, pr, armed, hitPhrase, hitWords } = stable.sort((a, b) => b.rank - a.rank)[0];
  instantGate.last = now;
  for (const w of hitWords) usedWord.set(w, now);
  // prominence follows confidence: armed (Claude expected it) full, name-only a little softer
  playSound({ s, x, p: armed ? 0.95 : 0.85, live: !!armed, beat: pr?.beat ?? "" }, hitPhrase, text, "PLAY INSTANT", armed ? 1 : 0.85);
  early.played.push({ id: s.id, x });
  const ms = lagMs + (Date.now() - arrived);
  lat.early.push(ms);
  say(C.fast, "LATENCY", `instant: ${s.id} fired ${ms} ms after "${hitPhrase}" was transcribed${armed ? " (armed by Claude)" : " (names the sound)"}${hits.length > 1 ? `; also matched ${hits.length - 1} other sound(s), picked the best fit` : ""}`);
  return true;
}

// EARLY FIRE while you're still talking (streaming only). Only the safe case fires here:
// the words so far CONFIRM one of Claude's predictions and exactly one sound clearly matches.
// Everything else waits for the full sentence (and Claude's context check if needed).
const early = { played: [] as { id: string; x: number[] }[], busy: false, lastWords: 0, t0: 0 };
async function handlePartial(text: string, lagMs = 0) {
  const arrived = Date.now();
  duck(); // words are coming in: dip the beds so the voice stays clear
  monitor?.watch(text); // fast lane: named sounds the library doesn't have (background, never waited on)
  if (instantScan(text, lagMs, arrived)) return;
  const n = text.split(/\s+/).length;
  if (!early.t0) early.t0 = Date.now();
  if (early.busy || n === early.lastWords || n < 3 || !state) return;
  early.busy = true; early.lastWords = n;
  try {
    const { tauNow } = currentTau();
    if (tauNow === Infinity) return;
    const cf = await contextFit(text, recent);
    const d = decide(text, index + 1, state.tension, Math.max(cf.fitPrediction, cf.fitStory), await soundMeaning(text));
    const c = d.ranked.filter(r => r.evidence && !early.played.some(e => e.id === r.s.id));
    // fire early when the words confirm a prediction, or when one sound is clearly named (phrase / live keyword)
    if (c.length !== 1 || c[0].weak || c[0].p <= tauNow || planBlocks(c[0].s)) return;
    if (!cf.confirmed && !(c[0].overlap >= 0.75 || c[0].live)) return;
    if (Date.now() - (lastPlayed.get(c[0].s.id) ?? 0) < REPEAT_MS) return;
    const word = triggerWord(text, c[0].s)?.word ?? "";
    if (!word) return; // nothing in the words names it: the sentence-level decision handles it
    say(C.fast, "FIT", `"${text}" confirms "${cf.bestBeat}" (${f2(cf.fitPrediction)}) — firing before the sentence ends`);
    playSound(c[0], word, text, "PLAY EARLY");
    lat.early.push(lagMs + (Date.now() - arrived));
    say(C.fast, "LATENCY", `early sound fired ${lagMs + (Date.now() - arrived)} ms after you said "${word}" (speech-to-text ${lagMs} ms + decision ${Date.now() - arrived} ms)`);
    early.played.push({ id: c[0].s.id, x: c[0].x });
  } finally { early.busy = false; }
}

// LATENCY: measured per sentence, so you can see the fast and slow loops actually working
const lat = { stt: [] as number[], fast: [] as number[], check: [] as number[], claude: [] as number[], early: [] as number[] };
const avgMs = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
let sttLag = 0;

// Sentences are handled one at a time, in order (the arbiter may wait on Claude)
let chain = Promise.resolve();
const handleQueued = (text: string, lagMs = 0) => {
  const arrived = Date.now();
  if (!text.trim().startsWith("/")) duck();
  chain = chain.then(() => { sttLag = lagMs; return handle(text, arrived); }).catch(e => console.error(e));
};

async function handle(text: string, arrived = Date.now()) {
  text = text.trim();
  if (!text) return;
  if (text.startsWith("/")) return command(text);
  monitor?.watch(text, true);
  if (progress() > 1 && !overtimeWarned) { overtimeWarned = true; say(C.music, "TIME", `past the ${clock.estMin} min estimate. Type /time N to extend, or the sound will wind down.`); }
  say(C.heard, "HEARD", text);
  const slot = index + 1;
  say(C.fast, "MAP", mapWords(text));
  // What Claude anticipated before this sentence (taken before a play consumes it) — scored against its hindsight later
  const anticipated = [...prior(slot).entries()].filter(([, v]) => v.p >= 0.4).map(([id]) => id);
  // CONTEXT: is this what Claude predicted, does it follow the story, or is it a random insert?
  // FAST LOOP-BACK: if this sentence clearly belongs to a paused thread, resume it right now (before Claude
  // answers), so the music and expectations are already right for this very sentence
  const back = await pausedThreadMatch(text);
  const fitActive = await similarity(text, [storyNow(), ...active.lines.slice(-3)].join(". "));
  if (back && back.sim >= FIT().high && back.sim > fitActive + 0.1)
    switchTo(back.t, `this sentence matches it (${f2(back.sim)} vs ${f2(fitActive)} for the current thread)`);
  const cf = await contextFit(text, recent);
  cfInsert = cf.insert;
  if (expects.length) scoreFeedback("fit", cf.confirmed || cf.fitPrediction >= FIT().low, cf.insert);
  say(C.fast, "FIT", `matches prediction ${f2(cf.fitPrediction)}${cf.bestBeat ? ` ("${cf.bestBeat}")` : ""} | follows story ${f2(cf.fitStory)}` +
    (cf.confirmed ? " → PREDICTION CONFIRMED" : cf.insert ? " → looks like a RANDOM INSERT" : ""));
  // FAST: score every sound against these words + everything Claude still expects
  const meaning = await soundMeaning(text);
  const d = decide(text, slot, state?.tension ?? 0.3, Math.max(cf.fitPrediction, cf.fitStory), meaning);
  say(C.fast, "FAST", d.ranked.slice(0, 3).map(r => `${r.s.id} p=${f2(r.p)} (claude ${f2(r.pri)}, words ${f2(r.overlap)})`).join(" | "));
  // Clearly unrelated speech (< 0.3) gets no sound effects; somewhat off-topic raises the bar
  const { onTopic, need, tauNow } = currentTau();
  // Sounds already fired while you were talking (streaming) count for this sentence; don't play them twice
  const already = early.played.splice(0);
  if (already.length) say(C.fast, "STREAM", `already played while you were talking: ${already.map(a => a.id).join(", ")}`);
  early.t0 = 0; early.lastWords = 0;

  // Ask Claude when the fast loop can't be sure: several sounds match the same sentence,
  // or the only match is weak (could be a mention, not an event). Clear single matches fire instantly.
  // Every sound whose words appear is offered (top 4), even if the fast loop scores it low:
  // Claude sees the whole sentence and may know better (e.g. "thunder crashed" before "door").
  // A random insert never triggers sound, however well its words match
  const contenders = tauNow === Infinity || cf.insert || already.length ? [] : d.ranked.filter(r => r.evidence && !already.some(a => a.id === r.s.id)).slice(0, 4);
  let picks: { r: typeof d.ranked[number]; word: string }[] = [];
  let claudeSaid = ""; // Claude's reason when it checked this sentence
  // Instant when one sound clearly matches (no Claude round trip, ~1.5 s saved); several matches or a weak one are still checked by Claude.
  const single = contenders.length === 1 && !contenders[0].weak && contenders[0].p > tauNow;
  if (single) {
    picks = [{ r: contenders[0], word: triggerWord(text, contenders[0].s)?.word ?? "" }];
  } else if (contenders.length >= 2 && !contenders[0].weak && contenders[0].p > tauNow && contenders[0].p - contenders[1].p >= 0.2) {
    picks = [{ r: contenders[0], word: triggerWord(text, contenders[0].s)?.word ?? "" }]; // clear leader: no round trip
  } else if (contenders.length >= 2 || (contenders.length === 1 && contenders[0].p > tauNow * 0.5)) {
    const cands = contenders.slice(0, 4).map(r => ({ id: r.s.id, p: r.p, word: triggerWord(text, r.s)?.word ?? "?" }));
    const why = cands.length > 1 ? `${cands.length} sounds match` : contenders[0].weak ? "weak match only" : "words match but the prediction isn't confirmed";
    say(C.slow, "ASK", `${why} (${cands.map(c => `${c.id} on "${c.word}"`).join(", ")}) → asking Claude to check the context`);
    const t0 = Date.now();
    const a = await arbitrate(text, cands, { recent, beats: [...new Set(expects.map(e => e.beat))] });
    if (a) {
      say(C.slow, "ASK", `Claude chose ${a.plays.map(x => `${x.id} on "${x.word}"`).join(" then ") || "silence"} (${Date.now() - t0} ms): ${a.reason}`);
      claudeSaid = a.reason;
      lat.check.push(Date.now() - t0);
      picks = a.plays.map(x => ({ r: contenders.find(c => c.s.id === x.id)!, word: x.word })).filter(x => x.r)
        // the landing word must really be in the sentence; otherwise use the matched word
        .map(x => ({ ...x, word: tagHit(norm(text), x.word) ? x.word : triggerWord(text, x.r.s)?.word ?? "" }));
      for (const c of contenders) learn(c.x, picks.some(x => x.r === c) ? 1 : 0); // Claude's choice is a lesson too
    } else {
      // no answer in time: trust a strong top match, drop a weak one
      const top = contenders.find(c => !c.weak && c.p > tauNow);
      say(C.slow, "ASK", top ? `no answer in time → using the strongest match (${top.s.id})` : "no answer in time → weak match dropped");
      picks = top ? [{ r: top, word: triggerWord(text, top.s)?.word ?? "" }] : [];
    }
  }

  const played: string[] = already.map(a => a.id);
  let lastBlock = "";
  for (const { r, word } of picks) {
    if (played.length >= 2) break; // at most 2 sounds per sentence
    const blocked = planBlocks(r.s);
    if (blocked) { lastBlock = `${r.s.id} fits, but ${blocked}`; continue; }
    played.push(r.s.id);
    playSound(r, word, text);
  }
  const sound = played.join(" + ");
  const decideMs = Date.now() - arrived;
  if (!claudeSaid) lat.fast.push(decideMs);
  if (sttLag) lat.stt.push(sttLag);
  say(C.fast, "LATENCY", `text arrived ${sttLag} ms after you said it | decision ${decideMs} ms after the text${claudeSaid ? " (included a Claude context check)" : " (fast loop only)"}` +
    ` | Claude's 3-step prediction runs in the background (avg ${avgMs(lat.claude)} ms, never waited on)`);
  if (!played.length) {
    mix.sentencesSinceSfx++;
    say(C.play, "SILENCE", lastBlock || (claudeSaid ? `Claude checked the context: ${claudeSaid}` : cf.insert && d.ranked.some(r => r.evidence) ? `words match ${d.ranked.find(r => r.evidence)!.s.id}, but the sentence doesn't follow the story or any prediction (random insert)` : tauNow === Infinity ? `speech looks unrelated (on-topic ${f2(onTopic)}), sound effects paused` : tauNow > TAU ? (need < 0.4 ? `this part doesn't call for effects (need ${f2(need)}), bar raised to ${f2(tauNow)}, music carries it` : `speech looks off-topic (${f2(onTopic)}), bar raised to ${f2(tauNow)}`) : picks.length === 0 && contenders.length >= 2 ? "Claude chose silence" : `nothing reached p ${f2(TAU)} with matching words`));
  }

  // MIX: every sentence, levels glide toward the plan for this part
  updateMix(state?.tension ?? 0.3);
  say(C.music, "MIX", `music ${bar(mix.music)} ${f2(mix.music)} (${layer.music.now || "—"}, ducks ~40% while you talk) | ambience ${bar(mix.ambience)} ${f2(mix.ambience)} (${layer.ambience.now || "—"})`);
  timeline.push({
    i: slot, text, arc: mix.arc, tension: state?.tension ?? 0.3, music: mix.music, sound,
    at: `${elapsedMin().toFixed(1)}m`, label: testLabel, expected: anticipated.join("/"), outcome: "no prediction", thread: active.id
  });
  // remember the fast loop's candidates so Claude's hindsight can teach the scorer
  pendingLabels.set(slot, { cands: d.ranked.map(r => ({ id: r.s.id, x: r.x })), played: sound, anticipated });

  // SLOW: send meaningful sentences to Claude in the background
  if (!meaningful(text)) return;
  index++;
  recent.push(`[${index}] ${text}`); if (recent.length > 8) recent.shift();
  if (!cfInsert) { active.lines.push(text); if (active.lines.length > 6) active.lines.shift(); heardQueue.push(text); topUp(""); } // what was just said drives the next scrape round, without waiting for Claude's prediction
  const i = index;
  predictNext3([...recent], i, state).then(r => {
    if (!r || i <= lastTracked) return;
    // THREADS (Claude's verdict): resume a paused thread, start a new one, or keep the active one
    const target = threads.find(t => t.id === r.state.thread);
    const before = active;
    if (target && target !== active) switchTo(target, "Claude recognised the return");
    else if (r.state.adopt_new_story && r.state.current_story && (r.state.thread === "new" || !target)) newThread(r.state.current_story);
    else if (target === active && r.state.current_story && r.state.continues_story >= 0.5) active.story = r.state.current_story; // keep the picture fresh
    const threadChanged = active !== before;
    // A reply about an insert or a not-yet-adopted new story must not overwrite the active thread's memory
    const onThread = threadChanged || !r.state.thread || r.state.thread === active.id;
    lastTracked = i; state = r.state;
    if (onThread) active.state = r.state;
    if (r.state.space) setSpace(r.state.space);
    if (rethink.pending) { rethink.pending = false; rethink.lowStreak = 0; rethink.surpriseStreak = 0; say(C.slow, "REGENERATE", "new picture in place"); }
    lat.claude.push(r.ms);
    const row = timeline.find(t => t.i === i);
    if (row) { row.onTopic = r.state.on_topic; row.claudeMs = r.ms; }
    ingestPrediction(i, r.slots);
    // PREFETCH (a bet, not a certainty): sounds Claude expects in the next moments that the library lacks are fetched now,
    // the likeliest first, so they're ready IF they come; the ones that never come cost a fetch, nothing else
    const bets = r.slots.flatMap(s => (s.missing ?? []).map(m => ({ ...m, beat: s.beat }))).filter(m => m.p >= 0.35).sort((a, b) => b.p - a.p).slice(0, 4);
    if (bets.length) say(C.slow, "PREFETCH", bets.map(b => `${b.sound} ${f2(b.p)}`).join(", "));
    topUp(r.slots.map(s => s.beat).filter(Boolean).join("; ") +
      (bets.length ? `\nLikely next sounds the library LACKS (fetch these first): ${bets.map(b => `${b.sound} (p ${f2(b.p)})`).join(", ")}` : ""), bets.length > 0);
    if (onThread) { setLiveWords(r.state.listen_for); if (Array.isArray(r.state.fits_now)) fitsNow = new Set(r.state.fits_now); }
    say(C.slow, "NEED", `sound need ${bar(r.state.sound_need ?? 0.5)} ${f2(r.state.sound_need ?? 0.5)} | focus: ${r.state.focus}`);
    if (r.state.scenario) say(C.slow, "SCENE", r.state.scenario);
    // MAIN THREAD SHIFT: old expectations no longer apply; re-plan the rest of the talk around the new focus
    // A random insert must not redirect the plan. A real switch shows up as the NEXT sentences continuing
    // the new thread, so the shift is accepted once a sentence both changes focus and continues the talk.
    const realShift = r.state.focus_changed && r.state.continues_story >= 0.5 && !threadChanged; // thread changes handled above
    if (r.state.focus_changed && !realShift) say(C.slow, "SHIFT", `ignored: [${i}] looks like a random insert (continues story ${f2(r.state.continues_story)}), keeping the plan`);
    if (realShift && i > 0) {
      say(C.music, "SHIFT", `main thread switched to "${r.state.focus}" → dropping old expectations, re-planning the rest of the talk`);
      expects = expects.filter(e => e.madeAt === i);
      mix.usedInArc = Math.min(mix.usedInArc, Math.max(0, budget(mix.arc) - 1)); // leave room for the new thread
      planWholeSpeech(r.state.focus).then(() => say(C.music, "PLAN", ARCS.map(a => `${a}: music ${f2(PLAN[a].music)}, ${budget(a)} sounds`).join(" | ")));
    }
    // LEARN from Claude's hindsight: which sound sentence [i] actually deserved
    const pend = pendingLabels.get(i);
    if (pend) {
      pendingLabels.delete(i);
      const truth = r.state.last_sound === "none" ? "" : r.state.last_sound;
      for (const c of pend.cands) learn(c.x, c.id === truth ? 1 : 0, c.id === truth ? 3 : 1); // rare positives count more
      const ok = truth ? pend.played.split(" + ").includes(truth) : pend.played === "";
      learnStats.total++; if (ok) learnStats.agree++;
      // EVAL: did Claude see it coming?  hit = deserved a sound Claude anticipated | surprise = deserved one it didn't
      //       quiet = deserved no sound (correct to wait)
      const outcome: Row["outcome"] = !truth ? "quiet" : pend.anticipated.includes(truth) ? "hit" : "surprise";
      if (truth) scoreFeedback("outcome", outcome === "hit");
      if (row) { row.hindsight = truth || "none"; row.outcome = outcome; }
      say(C.slow, "EVAL", `[${i}] deserved ${truth || "no sound"}; Claude had anticipated ${pend.anticipated.join("/") || "nothing"} → ${outcome.toUpperCase()}`);
      say(C.slow, "LEARN", `[${i}] hindsight: ${truth || "no sound"} | fast loop ${pend.played ? "played " + pend.played : "stayed silent"} → ${ok ? "CORRECT" : "WRONG"} ` +
        `(${learnStats.agree}/${learnStats.total} so far) | weights ${FEATS.map((f, k) => `${f} ${W[k].toFixed(2)}`).join(", ")}`);
    }
    say(C.slow, "CLAUDE", `after [${i}] (${r.ms} ms, on-topic ${f2(r.state.on_topic)}): ${r.state.scene} | ${r.state.setting} | tension ${f2(r.state.tension)} | ${r.state.arc} | mood ${r.state.mood}`);
    for (const s of r.slots)
      console.log(`         +${s.slot - i} [${s.slot}] ${s.beat} → ${s.sounds.map(x => `${x.id} ${f2(x.score)}`).join(", ") || "(no sound)"}`);
    const disagree = r.state.arc !== arcByTime() ? `${arcByTime()}/${r.state.arc}` : "";
    if (disagree && disagree !== lastDisagree)
      say(C.music, "TIME", `${clockText()}: clock says ${arcByTime()}, story says ${r.state.arc} → following the story`);
    lastDisagree = disagree;
    if (onThread) setArc(r.state.arc);
    if (onThread) vote("music", r.state.mood);
    if (onThread) vote("ambience", r.state.setting);
  });
}

// Adds freshly scraped records to the running talk: library, Claude's options, mixer, trigger phrases
async function mergeSounds(fresh: any[], dir: string, prep = true): Promise<Sound[]> {
  const added = toSounds(fresh, dir).filter(s => !LIBRARY.some(x => x.id === s.id));
  for (const s of toSounds(fresh, dir)) { const old = LIBRARY.find(x => x.id === s.id); if (old) old.files = [...new Set([...(old.files ?? []), ...(s.files ?? [])])]; }
  if (!added.length) return [];
  LIBRARY.push(...added);
  indexLibrary();
  preload(added.flatMap(s => (s.files ?? []).map(file => ({ file, role: s.role, id: s.id }))));
  if (prep) await prepareLibrary(); // trigger + instant phrases for the new sounds
  // the first music to arrive (batch 1 had none) starts straight away
  const music = added.find(s => s.role === "music" && s.files?.length);
  if (music && !layer.music.now) vote("music", music.mood ?? "");
  return added;
}

// BATCH 2: cli.ts fetched only the opening music + the likeliest effects before the talk; the rest of the plan
// (pending.json) is fetched here in the background, and each part joins the talk as soon as it's in
// MONITOR (monitor.ts): a sound that was named but missing has just been fetched. In time → it plays now; too late for a
// sharp hit → kept for the next mention (its instant phrases came with it); soft lasting sounds may still fade in late.
let monitor: ReturnType<typeof createMonitor> | null = null;
const FAST_DEADLINE_MS = 1500;
async function onFound(f: Found) {
  const added = await mergeSounds([f.rec], dirname(LIBRARY_FILE), false);
  const s = added[0] ?? LIBRARY.find(x => x.id === f.rec.slotId);
  if (!s?.files?.length) return;
  const late = Date.now() - f.heardAt;
  const lasting = (s.softness ?? 0.5) >= 0.55 && ((s.lengthS ?? 1) >= 1.5 || (s.attack ?? 0) >= 0.4);
  const fresh = Date.now() - (lastPlayed.get(s.id) ?? 0) >= REPEAT_MS;
  const what = fresh && late <= FAST_DEADLINE_MS ? "played in time" : fresh && lasting && late <= 9000 ? "faded in late" : "kept for the next mention";
  say(C.slow, "MONITOR", `${s.id} ready ${late} ms after "${f.word}" (Claude ${f.askedMs} ms) → ${what}`);
  if (what === "played in time") playSound({ s, x: [], p: 0.8, live: false, beat: "" }, f.word, f.word, "PLAY FAST");
  else if (what === "faded in late") playSound({ s, x: [], p: 0.6, live: false, beat: "" }, f.word, f.word, "PLAY LATE", 0.85);
}

async function loadBatch2() {
  const dir = dirname(LIBRARY_FILE);
  // the full plan is still being made in the background (cli.ts keeps `pending.waiting` until pending.json is written)
  for (let i = 0; i < 120 && !existsSync(join(dir, "pending.json")) && existsSync(join(dir, "pending.waiting")); i++) await new Promise(r => setTimeout(r, 1000));
  if (!existsSync(join(dir, "pending.json"))) return;
  // NOT holding the live-fetch lock any more: library.json writes take turns inside buildLibrary, so the live rounds
  // ("fetch what was just said") keep working while batch 2 runs (they used to wait up to 2 minutes behind it)
  const t0 = Date.now();
  say(C.slow, "SCRAPE", "batch 2: fetching the rest of the library in the background…");
  try {
    // each sound joins the talk the moment it's downloaded, not when the whole batch is done
    const added: Sound[] = [];
    let first = true;
    await finishLibrary(dir, undefined, async rec => {
      const a = await mergeSounds([rec], dir, false);
      added.push(...a);
      if (a.length && first) { first = false; say(C.slow, "SCRAPE", `batch 2: first new sound in after ${((Date.now() - t0) / 1000).toFixed(0)} s (${a[0].id}); more arriving…`); }
    });
    await prepareLibrary(); // phrases for any new sound that came without planner metadata
    const moods = added.filter(s => s.role === "music").map(s => s.mood);
    say(C.slow, "SCRAPE", `batch 2 in (${((Date.now() - t0) / 1000).toFixed(0)} s): +${added.length} sounds` +
      `${moods.length ? ` (music moods: ${moods.join(", ")})` : ""}: ${added.filter(s => s.role !== "music").map(s => s.id).join(", ")}`);
  } catch (e) {
    say(C.slow, "SCRAPE", `batch 2 failed (${(e as Error).message}); continuing with batch 1`);
  } finally { }
}

// LIVE SCRAPING FROM WHAT IS ACTUALLY SAID. Every meaningful sentence goes into `heardQueue`; whenever no fetch is running
// (and at least TOPUP_GAP_MS since the last one) everything heard since the last round is sent to the planner, which plans the
// concrete sounds those words name or imply, plus ordinary sounds likely next in THAT story. The pre-talk summary is only a loose
// hint and Claude's predicted beats are low-priority guesses: a library built from a vague theme must be corrected by the speech.
// A round takes one planner call + the downloads, so a sound named now lands several seconds later: it serves the next
// mention and the following sentences, and ambience beds can start straight away.
// FRONT-END NOTE: the same loop works unchanged on streamed transcripts from press-and-hold voice messages (one message = one chunk).
const heardQueue: string[] = [];
const MAX_TOPUPS = 20, TOPUP_GAP_MS = 4_000; // faster rounds: a sound must be in the library before it's named
let topUps = 0, lastTopUp = 0, topUpBusy = false, stuckSaid = false;
let pendingBets = "";
async function topUp(upcoming: string, urgent = false) {
  if (urgent) pendingBets = upcoming; // kept until a round runs, even if one is busy now
  if (topUpBusy || topUps >= MAX_TOPUPS || LIBRARY === DEMO_LIBRARY || !existsSync(LIBRARY_FILE)) return;
  if (!upcoming && pendingBets) { upcoming = pendingBets; urgent = true; }
  if (!heardQueue.length && !upcoming) return;
  if (!urgent && topUps > 0 && Date.now() - lastTopUp < TOPUP_GAP_MS) return; // what was heard stays queued for the next round
  if (urgent) pendingBets = "";
  if (providerStatus().stuck) { heardQueue.length = 0; if (!stuckSaid) { stuckSaid = true; say(C.slow, "SCRAPE", "Freesound is rate-limited and ElevenLabs is out of credits: live scraping is paused (no sounds can be fetched right now)"); } return; }
  topUpBusy = true; lastTopUp = Date.now(); topUps++;
  const heard = heardQueue.splice(0).slice(-6).join(" ") || recent.slice(-2).join(" ");
  const heardAt = Date.now();
  const dir = dirname(LIBRARY_FILE);
  try {
    say(C.slow, "SCRAPE", `round ${topUps + 1}: asking the live director about "${heard.slice(0, 80)}${heard.length > 80 ? "…" : ""}"`);
    const have = new Set(LIBRARY.map(s => s.id));
    // EVIDENCE for the live director (planner.ts LIVE_DIRECTOR): it decides what, if anything, to add. No topic or genre is
    // assumed here; the pre-talk summary is passed as a prior and the speech as the evidence that overrides it.
    const inventory = LIBRARY.filter(s => s.role !== "music").map(s => `${s.id}${s.description ? ` (${s.description.slice(0, 40)})` : ""}${lastPlayed.has(s.id) ? " [played]" : ""}`).join("; ");
    const prompt = `EVIDENCE FOR THIS ROUND\n` +
      `Just said (most recent last): "${heard}"\n` +
      `Pre-talk plan (only a prior): "${STORY.summary}"; tone ${STORY.tone}\n` +
      `Playing now: music "${layer.music.now || "none"}", ambience "${layer.ambience.now || "none"}"; tension ${f2(state?.tension ?? 0.3)}; part of the talk: ${mix.arc}\n` +
      `Library (id (what it is) [played if already used]): ${inventory}\n` +
      (upcoming ? `Predicted next moments (low confidence, may be wrong): ${upcoming}\n` : "") +
      `Decide the best action.`;
    const fresh = await expandLibrary(prompt, have, dir, undefined, [], p => {
      if (p.read) say(C.slow, "SCRAPE", `director: ${p.read}`);
      if (!p.sfx.filter(s => !have.has(s.id)).length) say(C.slow, "SCRAPE", "director: the library already covers this, nothing to fetch");
    });
    const added = await mergeSounds(fresh, dir);
    if (!added.length) return;
    // LATE ENTRY: a sound named in what was just said arrived too late for the word. Soft, lasting sounds (birdsong, wind,
    // a crowd, rain) still work faded in a few seconds late; sharp one-offs (a crash, a knock) would sound wrong late → skipped.
    // Decided from the sound's own metadata, not from its name.
    for (const s of added) {
      if (s.role !== "sfx" || Date.now() - heardAt > 9000 || Date.now() - (lastPlayed.get(s.id) ?? 0) < REPEAT_MS) continue;
      const lasting = (s.softness ?? 0.5) >= 0.55 && ((s.lengthS ?? 1) >= 1.5 || (s.attack ?? 0) >= 0.4);
      const tw = triggerWord(heard, s);
      if (!lasting || !tw) continue;
      playSound({ s, x: [], p: 0.6, live: false, beat: "" } as any, tw.word, heard, "PLAY LATE", 0.85);
      break; // one late entry per round at most
    }
    say(C.slow, "SCRAPE", `added ${added.length} sounds in ${((Date.now() - lastTopUp) / 1000).toFixed(0)} s: ${added.map(s => s.id).join(", ")}`);
  } catch (e) {
    say(C.slow, "SCRAPE", `follow-up scrape failed (${(e as Error).message}); continuing with the current library`);
  } finally { topUpBusy = false; if (pendingBets) topUp(""); else if (heardQueue.length) setTimeout(() => topUp(""), TOPUP_GAP_MS); } // bets first, then speech that arrived meanwhile
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) return console.error("Set ANTHROPIC_API_KEY first.");
  // One queue for all keyboard input, so nothing typed (or pasted) early gets lost
  const rl = readline.createInterface({ input: process.stdin });
  const queued: string[] = [];
  let waiting: ((l: string) => void) | null = null;
  let onLine: ((l: string) => void) | null = null;
  rl.on("line", l => { if (waiting) { const w = waiting; waiting = null; w(l); } else if (onLine) onLine(l); else queued.push(l); });
  const nextLine = () => new Promise<string>(r => (queued.length ? r(queued.shift()!) : (waiting = r)));
  const ask = async (q: string, def: string) => {
    process.stdout.write(`${q} [${def}]: `);
    const a = (await nextLine()).trim();
    if (!process.stdin.isTTY) console.log(a); // echo when input is piped (tests)
    return a || def;
  };

  // ---- setup, in place of the setup screen (Enter keeps the default) ----
  // cli.ts passes its answers in a file (--setup <json>), so nothing is asked twice
  const setupArg = process.argv.indexOf("--setup");
  const preset = setupArg >= 0 && existsSync(process.argv[setupArg + 1]) ? JSON.parse(readFileSync(process.argv[setupArg + 1], "utf8")) : null;
  if (preset) {
    const kws: string[] = (Array.isArray(preset.keywords) && preset.keywords.length ? preset.keywords
      : CUES.flatMap(s => s.tags.slice(0, 2))).map((k: string) => String(k).toLowerCase().trim()).filter(Boolean);
    Object.assign(STORY, {
      summary: preset.theme && !String(preset.summary).toLowerCase().includes(String(preset.theme).toLowerCase()) ? `${preset.theme}: ${preset.summary}` : preset.summary,
      keywords: [...new Set(kws)], tone: preset.tone, density: preset.density
    });
    TAU = BASE_TAU[STORY.density];
    if (!clock.estMin) clock.estMin = Number(preset.minutes) || 5;
    console.log(`Setup loaded: "${STORY.summary}" | ${STORY.density} | ~${clock.estMin} min`);
  } else {
    console.log("Setup — press Enter to keep the value in brackets.\n");
    STORY.summary = await ask("What is your talk about (story, vibe, goal)?", STORY.summary);
    STORY.keywords = (await ask("Keywords, comma separated", STORY.keywords.join(", "))).split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
    STORY.tone = await ask("Tone", STORY.tone);
    const dens = await ask("How much sound: subtle / normal / expressive", STORY.density);
    STORY.density = (["subtle", "normal", "expressive"].includes(dens) ? dens : "normal") as typeof STORY.density;
    TAU = BASE_TAU[STORY.density];
    if (!clock.estMin) clock.estMin = Number(await ask("How many minutes will you talk?", "5")) || 5;
  }
  console.log("\nPlanning the sound for the whole talk…");
  process.stdout.write("Loading the context model (first run downloads ~25 MB)… ");
  // model load ~5-10 s and the talk plan (one Claude call) run together; library prep (only for sounds the scraper's
  // planner didn't already describe) runs in the background and never holds up the start. Until it lands, those sounds
  // use the built-in phrase heuristics.
  const sfxLib = LIBRARY.filter(s => s.role === "sfx" || s.role === "stinger");
  const withMeta = sfxLib.filter(s => s.emphasis !== undefined && s.softness !== undefined && s.lengthS !== undefined && s.attack !== undefined && s.tail !== undefined).length;
  prepareLibrary().then(r => console.log(`\nSound library: ${LIBRARY.length} sounds from ${existsSync(LIBRARY_FILE) ? LIBRARY_FILE : "the built-in demo"} → ${r}\n  planner metadata (length / softness / attack / tail / emphasis) on ${withMeta}/${sfxLib.length} effects${withMeta < sfxLib.length ? " (the rest use the measured clip + defaults)" : ""}`));
  await Promise.all([
    loadEmbedder().then(() => console.log(embedder ? "ready" : "not available, using word overlap (run: npm install @huggingface/transformers)")),
    planWholeSpeech(),
  ]);
  console.log(`Sound plan for a ${clock.estMin} min talk${clock.speed !== 1 ? ` (test clock ${clock.speed}x)` : ""}:`);
  console.table(Object.fromEntries(ARCS.map(a => [a, { ...PLAN[a], sounds: budget(a) }])));
  process.on("SIGINT", endTalk);
  console.log(existsSync(WEIGHTS_FILE) ? `Loaded learned weights from ${WEIGHTS_FILE}` : "Starting with default weights (they'll be saved to weights.json at /end)");
  // --room: phones join a speaker room and play every sound together; the talk waits until the host presses Start
  if (process.argv.includes("--room")) {
    const room = await startRoom(LIBRARY.flatMap(s => s.files ?? []), m => say(C.music, "ROOM", m));
    console.log(`\nSpeaker room: on a phone on this Wi-Fi open ${room.urls[0]}\n  Share a story → Become host, then Start the talk when the phones are Ready.`);
    await room.engine.started;
    console.log("Host pressed Start — starting the talk.\n");
  } else if (process.argv.includes("--web")) {
    // --web: sound goes to the browser mixer (crossfades, ducking, smooth levels); otherwise afplay plays from the terminal
    try {
      const url = await startMixer();
      console.log(`\nBrowser mixer: ${url}  (opening it — click "Start" there to enable audio)`);
      await waitForBrowser();
      console.log("Browser connected — starting the talk.\n");
    } catch (e) { console.log(`Browser mixer unavailable (${(e as Error).message}); using ${playerName()} instead.`); }
  }
  setMixLogger(m => say(C.music, "MIXCHECK", m));
  const analysed = preload(LIBRARY.flatMap(s => (s.files ?? []).map(file => ({ file, role: s.role, id: s.id }))));
  if (analysed.length) console.log("Music & stingers (tempo, key):\n  " + analysed.join("\n  "));
  clock.startedAt = Date.now();
  loadBatch2(); // background: the rest of the library arrives while you talk
  if (LIBRARY !== DEMO_LIBRARY && existsSync(LIBRARY_FILE)) monitor = createMonitor({
    dir: dirname(LIBRARY_FILE),
    library: () => LIBRARY.filter(s => s.role !== "music").map(s => `${s.id}${s.description ? ` (${s.description.slice(0, 30)})` : ""}`),
    onFound, log: m => say(C.slow, "MONITOR", m),
  });
  active.story = STORY.summary; threads.push(active);
  // Music from the first second (the library's first mood); the ambience starts as soon as Claude
  // has heard enough to know where the talk is set
  vote("music", MOODS[0]);

  console.log(`\n${HELP}\n`);
  if (process.argv.includes("--type")) {
    console.log("Type the story one sentence at a time.\n");
    // --stream: replay each typed line word by word, like live streaming, to test early firing without a mic
    onLine = process.argv.includes("--stream")
      ? (line: string) => {
        if (line.trim().startsWith("/")) return handleQueued(line);
        const ws = line.trim().split(/\s+/);
        chain = chain.then(async () => {
          for (let k = 1; k <= ws.length; k++) { await handlePartial(ws.slice(0, k).join(" ")); await new Promise(r => setTimeout(r, 250)); }
        });
        handleQueued(line);
      }
      : handleQueued;
    queued.splice(0).forEach(onLine); // anything typed while the plan was loading
    rl.on("close", () => { chain.then(() => setTimeout(printTimeline, 1500)); });
    // run by the room server: the host phone's microphone arrives as words over IPC (room/mic.ts), streaming like the
    // local mic does; the server gets the trigger words for its speech model, as setKeyterms would get them below
    if (inTalkChild()) {
      process.send!({ op: "keyterms", terms: [...CUES.flatMap(s => [...(s.instant ?? []), ...s.tags]), ...STORY.keywords].filter(t => t.split(/\s+/).length <= 3) });
      process.on("message", (m: any) => {
        if (typeof m?.text !== "string" || !m.text.trim()) return;
        const text = m.text.replace(/^\s*\/+/, ""); // spoken words are never commands
        if (m.op === "partial") handlePartial(text, Number(m.lagMs) || 0).catch(() => { });
        else if (m.op === "final") handleQueued(text);
      });
    }
    return;
  }

  // mic mode: the keyboard still works for commands
  onLine = line => { if (line.trim().startsWith("/")) command(line); };
  queued.splice(0).forEach(onLine);
  console.log("Listening… speak in sentences. Type commands + Enter anytime.\n");
  setKeyterms([...CUES.flatMap(s => [...(s.instant ?? []), ...s.tags]), ...STORY.keywords].filter(t => t.split(/\s+/).length <= 3)); // the speech model hears these words right
  await listen(handleQueued, msg => say(C.fast, "MIC", msg), (text, lag) => { handlePartial(text, lag).catch(() => { }); });
}

// =====================================================================
// 7. CONSOLE COMMANDS — replace the remote and the settings screen
// =====================================================================
let lastSound = "";
const HELP = `Commands:
  /time 8    change how long you expect to talk (minutes)
  /skip      the last sound was wrong → be pickier
  /good      the last sound worked → allow a bit more
  /status    where the talk is now: time, part, music, budgets
  /plan      show the sound plan
  /test 80   label what you say next (how related to the summary, e.g. 100 / 80 / 50 / 20)
  /end       finish: timeline + accuracy per label (and save what the scorer learned)`;

function command(line: string) {
  const [cmd, arg] = line.trim().split(/\s+/);
  const base = BASE_TAU[STORY.density];
  switch (cmd) {
    case "/time": return setEstimate(Number(arg));
    case "/skip": {
      if (!lastSound) return say(C.music, "CMD", "no sound to skip yet");
      // (a one-shot already playing can't be cut; the scorer still learns it was wrong)
      TAU = Math.min(base + 0.25, TAU + 0.05);
      if (lastSoundX.length) learn(lastSoundX, 0, 3); // strong "wrong" label for the scorer
      const t = [...timeline].reverse().find(x => x.sound === lastSound);
      if (t) t.sound += " (skipped)";
      return say(C.music, "CMD", `faded out ${lastSound}. Threshold ${f2(TAU)} (pickier)`);
    }
    case "/good":
      TAU = Math.max(base - 0.15, TAU - 0.02);
      if (lastSoundX.length) learn(lastSoundX, 1, 2); // "right" label for the scorer
      return say(C.music, "CMD", `noted. Threshold ${f2(TAU)}`);
    case "/status":
      say(C.music, "STATUS", `${clockText()} | part ${mix.arc} | tension ${f2(state?.tension ?? 0.3)} | ` +
        `music ${layer.music.now || "—"} ${f2(mix.music)} | ambience ${layer.ambience.now || "—"} ${f2(mix.ambience)} | ` +
        `sounds ${mix.usedInArc}/${budget(mix.arc)} in ${mix.arc} | threshold ${f2(TAU)} | label ${testLabel}`);
      say(C.music, "THREADS", threadList());
      return say(C.music, "LATENCY", latencySummary());
    case "/test":
      testLabel = !arg ? "unlabeled" : /^\d+%?$/.test(arg) ? `${arg.replace("%", "")}%` : arg; // /test 80 or /test insert
      return say(C.music, "TEST", `now labeling sentences as "${testLabel}" related to the summary`);
    case "/plan":
      return console.table(Object.fromEntries(ARCS.map(a => [a, { ...PLAN[a], sounds: budget(a) }])));
    case "/end":
      return endTalk();
    default:
      console.log(HELP);
  }
}

function latencySummary() {
  return `avg: speech-to-text ${avgMs(lat.stt)} ms | fast decision ${avgMs(lat.fast)} ms | Claude context check ${avgMs(lat.check)} ms (${lat.check.length}x)` +
    ` | early sounds ${avgMs(lat.early)} ms after the word (${lat.early.length}x) | Claude 3-step prediction ${avgMs(lat.claude)} ms (background)`;
}

// /end or Ctrl+C: the whole speech at a glance + accuracy per /test label
function printTimeline() {
  stopAll();
  console.log("\n──── whole speech ────");
  for (const t of timeline)
    console.log(`${String(t.i).padStart(3)} ${t.at.padStart(5)} ${(t.thread ?? "").padStart(3)} ${t.label.padStart(5)} ${t.arc.padEnd(10)} on-topic ${t.onTopic === undefined ? "  — " : f2(t.onTopic)}  ` +
      `${t.outcome.padEnd(8)} ${(t.sound ? "♪ " + t.sound : "·").padEnd(18)} hindsight ${(t.hindsight ?? "?").padEnd(14)} ${t.text.slice(0, 40)}`);
  const n = timeline.filter(t => t.sound).length;
  console.log(`${timeline.length} sentences, ${n} sounds (${Math.round((100 * n) / Math.max(1, timeline.length))}% of sentences)`);

  console.log(`\n──── latency ────\n${latencySummary()}`);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const labels = [...new Set(timeline.map(t => t.label))];
  console.log("\n──── accuracy by label ────");
  console.table(Object.fromEntries(labels.map(l => {
    const rows = timeline.filter(t => t.label === l);
    const judged = rows.filter(t => t.outcome !== "no prediction");
    const count = (o: Row["outcome"]) => judged.filter(t => t.outcome === o).length;
    const onTopic = avg(rows.filter(t => t.onTopic !== undefined).map(t => t.onTopic!));
    return [l, {
      sentences: rows.length,
      "Claude on-topic": Number.isNaN(onTopic) ? "—" : f2(onTopic),
      "saw it coming": count("hit") + count("surprise") ? `${Math.round((100 * count("hit")) / (count("hit") + count("surprise")))}%` : "—",
      hit: count("hit"), surprise: count("surprise"), quiet: count("quiet"),
      "sounds played": rows.filter(t => t.sound).length,
      "sounds on off-topic speech": rows.filter(t => t.sound && (t.onTopic ?? 1) < 0.3).length,
      "fast loop vs hindsight": (() => {
        const h = rows.filter(t => t.hindsight !== undefined);
        return h.length ? `${Math.round((100 * h.filter(t => t.hindsight === "none" ? !t.sound : t.sound.split(" + ").some(x => x.replace(" (skipped)", "") === t.hindsight)).length) / h.length)}%` : "—";
      })(),
      "Claude ms": Math.round(avg(rows.filter(t => t.claudeMs).map(t => t.claudeMs!))) || "—",
    }];
  })));
  console.log(`learned weights: ${FEATS.map((f, k) => `${f} ${W[k].toFixed(2)}`).join(", ")} (${learnStats.updates} updates, saved to ${WEIGHTS_FILE})`);
  console.log("saw it coming = of the sentences that deserved a sound (Claude's hindsight), how many Claude had anticipated.\n" +
    "fast loop vs hindsight = how often the instant decision matched what Claude judged right afterwards.\n" +
    "On unrelated speech a good model stays accurate by predicting silence (quiet) and plays ~0 sounds on off-topic speech.");
}

main();
