// player.ts — real-time MIXER + MIX MONITOR, so music, ambience and effects blend like a DJ set
//
// PREPARE (once per clip, at startup)
//   decode (ffmpeg/sox) → trim silence → match loudness → edge fades (no clicks) → seamless loop seam (beds)
//   ANALYZE like a DJ app: tempo (BPM) + beat phase, musical key (→ Camelot code), tonal vs. noise
//
// MIX (one continuous stream to the speakers, so every sample is under control)
//   • music/ambience changes are EQUAL-POWER crossfades (no loudness dip or bump in the middle)
//   • music switches wait for the NEXT BAR of the current track (≤ 4 s), like a DJ dropping on the downbeat
//   • level changes glide on an S-curve; beds duck under your voice and under each effect; soft limiter on the sum
//   • beds duck a moment BEFORE an effect lands (lookahead), and effects get a touch of shared room reverb,
//     so they sit inside the music instead of on top of it
//   • stingers land on the next BEAT if one is close; tonal stingers in a clashing key are played quieter
//
// MONITOR: every transition is checked (tempo gap, key compatibility, loudness) and reported, and when several
// tracks fit the same mood, the most compatible one with what's playing is chosen (harmonic mixing).
//
// MIXER_OUT=file.wav renders to a file instead of the speakers (used to verify the result).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const SR = 44100;
const has = (cmd: string) => spawnSync("which", [cmd]).status === 0;
const DECODER = has("ffmpeg") ? "ffmpeg" : has("sox") ? "sox" : "";
const OUT_FILE = process.env.MIXER_OUT ?? "";
const OUTPUT = OUT_FILE ? "file" : has("sox") ? "sox" : has("ffplay") ? "ffplay" : "";
export const playerReady = () => !!DECODER && !!OUTPUT;
export const playerName = () => playerReady() ? `mixer (${DECODER} → ${OUTPUT})` : `none (install sox and ffmpeg: brew install sox ffmpeg)`;
let log: (msg: string) => void = () => { };
export function setMixLogger(fn: (msg: string) => void) { log = fn; }
const dbToGain = (db: number) => Math.pow(10, db / 20);
// MIX LEVELS (dB). Effects sit clearly ON TOP of the music: beds are normalised 10 dB below effects and dip a further
// 9 dB the moment an effect hits. Tune without code: MIX_BED_DB=-22 MIX_FX_DB=-10 MIX_FX_DUCK_DB=-9 npm run dev
// was -21: with effects placed RELATIVE to the music, a quiet bed made the whole output quiet (music ~-38 dB, effects
// ~-29 dB in a render: near-silent on laptop speakers). -15 puts music around -25 dB and effects at -23..-13 dB.
const BED_DB = Number(process.env.MIX_BED_DB ?? -15);      // music + ambience loudness
const FX_DB = Number(process.env.MIX_FX_DB ?? -11);        // instant sound loudness (was -12)
const FX_DUCK_DB = Number(process.env.MIX_FX_DUCK_DB ?? -5); // dip of the beds under a pivotal effect (-9 made the music drop out: effects sounded cut out of the mix)
const FX_DUCK_MAX_S = 0.8; // the music dips only under the HIT; the effect's tail rides back inside the music

// =====================================================================
// ANALYSIS: tempo, beat phase, key — the same things DJ software reads from a track
// =====================================================================
type Info = { bpm: number; beatPhase: number; key: string; camelot: string; tonal: boolean; rms: number; seconds: number };

function fft(re: Float64Array, im: Float64Array) { // in-place radix-2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]];[im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]; // Krumhansl key profiles
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Camelot wheel: neighbours on the wheel mix harmonically
const CAM_MAJ = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAM_MIN = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

function analyze(x: Float32Array): Info {
  const seconds = x.length / SR;
  const y = x.length > 30 * SR ? x.subarray(0, 30 * SR) : x; // 30 s is plenty
  // --- tempo: onset strength (rise in energy) every 512 samples, then autocorrelation over 60–180 BPM
  const hop = 512, fps = SR / hop, frames = Math.floor(y.length / hop);
  const onset = new Float64Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0; // energy over a 2048-sample window: smooths out tone "beating" so only real attacks count
    for (let i = Math.max(0, f * hop - 768); i < Math.min(y.length, f * hop + 1280); i++) e += y[i] * y[i];
    const le = Math.log(1e-9 + e);
    onset[f] = Math.max(0, le - prev); prev = le;
  }
  // comb: a true beat period also lines up at 2, 3, 4 beats; prior favours ~120 BPM (avoids 3/2 and double-time errors)
  const ac = (lag: number) => { let s = 0; for (let f = Math.ceil(lag); f < frames; f++) s += onset[f] * onset[Math.round(f - lag)]; return s; };
  let bpm = 0, best = 0;
  for (let b = 60; b <= 180; b += 0.5) {
    const lag = fps * 60 / b;
    let s = 0;
    for (let k = 1; k <= 4; k++) if (k * lag < frames) s += ac(k * lag) / k;
    s *= Math.exp(-0.5 * Math.pow(Math.log2(b / 120) / 0.6, 2));
    if (s > best) { best = s; bpm = b; }
  }
  let beatPhase = 0, bp = -1;
  const per = fps * 60 / (bpm || 120);
  for (let ph = 0; ph < per; ph++) {
    let s = 0;
    for (let f = ph; f < frames; f += per) s += onset[Math.round(f)] ?? 0;
    if (s > bp) { bp = s; beatPhase = (ph / fps); }
  }
  const rhythmic = best > 0 && frames > fps * 4;
  // --- key: chroma (energy per note name) from the spectrum, matched against major/minor profiles
  const N = 8192, chroma = new Float64Array(12);
  for (let start = 0; start + N <= y.length; start += N) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = y[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * SR) / N;
      if (f < 55 || f > 2000) continue;
      const pc = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12;
      chroma[pc] += Math.hypot(re[k], im[k]);
    }
  }
  const mean = chroma.reduce((a, b) => a + b, 0) / 12 || 1;
  const tonal = Math.max(...chroma) / mean > 2.2; // one or a few notes dominate → it has a key
  let key = "", camelot = "", bestR = -2;
  const corr = (p: number[], r: number) => {
    const pm = p.reduce((a, b) => a + b, 0) / 12;
    let n = 0, d1 = 0, d2 = 0;
    for (let i = 0; i < 12; i++) { const a = chroma[(i + r) % 12] - mean, b = p[i] - pm; n += a * b; d1 += a * a; d2 += b * b; }
    return n / Math.sqrt(d1 * d2 || 1);
  };
  for (let r = 0; r < 12; r++) {
    const cM = corr(MAJOR, r), cm = corr(MINOR, r);
    if (cM > bestR) { bestR = cM; key = `${NOTES[r]} major`; camelot = CAM_MAJ[r]; }
    if (cm > bestR) { bestR = cm; key = `${NOTES[r]} minor`; camelot = CAM_MIN[r]; }
  }
  let sum = 0; for (const v of x) sum += v * v;
  return { bpm: rhythmic ? bpm : 0, beatPhase, key: tonal ? key : "", camelot: tonal ? camelot : "", tonal, rms: Math.sqrt(sum / x.length), seconds };
}

// Camelot distance: 0 same key, 1 = neighbour (harmonic), bigger = clash
function keyDistance(a: string, b: string): number {
  if (!a || !b) return 0; // noise / no key → can't clash
  const na = parseInt(a), nb = parseInt(b), la = a.slice(-1), lb = b.slice(-1);
  const step = Math.min(Math.abs(na - nb), 12 - Math.abs(na - nb));
  return step + (la === lb ? 0 : step === 0 ? 1 : 2);
}
function tempoGap(a: number, b: number): number { // % difference, allowing half/double time
  if (!a || !b) return 0;
  return Math.min(...[b, b * 2, b / 2].map(t => Math.abs(t - a) / a)) * 100;
}

// =====================================================================
// PREPARE clips
// =====================================================================
// MEASURED METADATA: what the audio actually is, read from the decoded clip (no AI, no latency: done once at preload).
//   crest  = peak / RMS (high = sharp transient: crash, click; low = smooth: rain, murmur)
//   attackMs = time to reach 70% of the peak
//   zcrHz  = zero-crossing rate, a cheap brightness measure (high = hissy / bright, low = dark / low)
//   impulseDb = how far the loudest 10 ms stands above the clip's TYPICAL (median) 10 ms. ~0-4 dB = steady texture (rain, crowd,
//             hum); 15+ dB = discrete hit (slam, click, bang). This, not brightness, is what separates a hit from a texture.
//   riseMs = time for the energy envelope to go from 10% to 90% of its maximum (fast = percussive, slow = swell)
//   levelDb = how far below the FX_DB target the clip ends up. Sharp clips are peak-limited during normalisation, so
//             they come out quieter than a smooth clip of the same nominal level; the mixer adds this back.
export type Profile = { crest: number; attackMs: number; zcrHz: number; impulseDb: number; riseMs: number; levelDb: number; seconds: number };
function profile(x: Float32Array, rms: number, peak: number, g: number): Profile {
  let zc = 0;
  for (let i = 1; i < x.length; i++) if ((x[i] >= 0) !== (x[i - 1] >= 0)) zc++;
  const seconds = x.length / SR, w = Math.max(1, Math.round(0.002 * SR));
  let attackMs = seconds * 1000;
  for (let i = 0; i < x.length; i += w) {
    let m = 0;
    for (let j = i; j < Math.min(i + w, x.length); j++) m = Math.max(m, Math.abs(x[j]));
    if (m >= 0.7 * peak) { attackMs = (i / SR) * 1000; break; }
  }
  // 10 ms RMS energy envelope
  const fw = Math.max(1, Math.round(0.01 * SR)), env: number[] = [];
  for (let i = 0; i + fw <= x.length; i += fw) {
    let s = 0;
    for (let j = i; j < i + fw; j++) s += x[j] * x[j];
    env.push(Math.sqrt(s / fw));
  }
  let impulseDb = 0, riseMs = seconds * 1000;
  if (env.length >= 3) {
    const mx = Math.max(...env);
    // typical level = median of the ACTIVE frames (within 20 dB of the loudest), so a quiet decay tail or the gaps between
    // bursts do not make a soft sound look like a hit
    const act = env.filter(e => e >= 0.1 * mx).sort((a, b) => a - b), med = Math.max(act[act.length >> 1], 1e-5);
    impulseDb = 20 * Math.log10(Math.max(mx, 1e-5) / med);
    const iPk = env.indexOf(mx);
    let i10 = 0, i90 = iPk;
    for (let i = 0; i <= iPk; i++) if (env[i] >= 0.1 * mx) { i10 = i; break; }
    for (let i = i10; i <= iPk; i++) if (env[i] >= 0.9 * mx) { i90 = i; break; }
    riseMs = Math.max(0, (i90 - i10) * 10);
  }
  return {
    crest: peak / rms, attackMs, zcrHz: zc / 2 / Math.max(seconds, 1e-3), impulseDb, riseMs, seconds,
    levelDb: 20 * Math.log10(Math.min(1, (g * rms) / dbToGain(FX_DB))), // 0 = on target, negative = peak-limited (quieter)
  };
}
const cache = new Map<string, { buf: Float32Array; info: Info; prof?: Profile }>();
export const soundProfile = (file?: string) => (file ? cache.get(`fx:${file}`)?.prof : undefined);

function decode(file: string): Float32Array | null {
  const args = DECODER === "ffmpeg"
    ? ["-v", "quiet", "-i", file, "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"]
    : [file, "-t", "f32", "-r", String(SR), "-c", "1", "-"];
  const r = spawnSync(DECODER, args, { maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

function prepare(file: string, kind: "fx" | "bed") {
  const key = `${kind}:${file}`;
  if (cache.has(key)) return cache.get(key)!;
  if (!file || !existsSync(file) || !DECODER) return null;
  let x = decode(file);
  if (!x || x.length < 64) return null;
  const th = dbToGain(-50); // trim silence
  let a = 0, z = x.length - 1;
  while (a < z && Math.abs(x[a]) < th) a++;
  while (z > a && Math.abs(x[z]) < th) z--;
  x = x.slice(a, z + 1);
  const info = analyze(x);
  if (kind === "fx" && x.length > 6 * SR) { // long scraped clip: keep 6 s, fade out the last 0.6 s
    x = x.slice(0, 6 * SR);
    const f = Math.round(0.6 * SR);
    for (let i = 0; i < f; i++) x[x.length - f + i] *= 1 - i / f;
  }
  let sum = 0, peak = 0; // loudness match (RMS) with a peak limit
  for (const v of x) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
  const rmsNow = Math.sqrt(sum / x.length) || 1e-6;
  const g = Math.min(dbToGain(kind === "fx" ? FX_DB : BED_DB) / rmsNow, 0.95 / (peak || 1));
  const prof = kind === "fx" ? profile(x, rmsNow, peak || 1e-6, g) : undefined; // measured before scaling
  if (kind === "bed") {
    // BEDS reach their loudness target even when a few peaks would clip: the gain is set from the average level, and only
    // the peaks above 0.7 are rounded off (soft limiting). Before, peak-capped scaling left peaky music ~15 dB under target.
    const gb = dbToGain(BED_DB) / rmsNow, knee = 0.7;
    for (let i = 0; i < x.length; i++) {
      const v = x[i] * gb, a = Math.abs(v);
      x[i] = a <= knee ? v : Math.sign(v) * (knee + (0.98 - knee) * Math.tanh((a - knee) / (0.98 - knee)));
    }
  } else for (let i = 0; i < x.length; i++) x[i] *= g;
  if (kind === "fx") { // soft attack (no click, no harsh onset) and a natural-length release
    const fi = Math.round(0.008 * SR), fo = Math.min(Math.round(0.12 * SR), x.length >> 1);
    for (let i = 0; i < fi && i < x.length; i++) x[i] *= i / fi;
    for (let i = 0; i < fo; i++) x[x.length - 1 - i] *= Math.pow(i / fo, 1.5);
  } else { // seamless loop: the end crossfades into the start
    const c = Math.min(Math.round(1.5 * SR), x.length >> 2);
    for (let i = 0; i < c; i++) { const t = i / c; x[i] = x[i] * Math.sin(t * Math.PI / 2) + x[x.length - c + i] * Math.cos(t * Math.PI / 2); }
    x = x.slice(0, x.length - c);
  }
  const out = { buf: x, info, prof };
  cache.set(key, out);
  return out;
}

export function preload(sounds: { file?: string; role: string; id: string }[]): string[] {
  const lines: string[] = [];
  for (const s of sounds) {
    if (!s.file) continue;
    const p = prepare(s.file, s.role === "music" || s.role === "ambience" ? "bed" : "fx");
    if (p && (s.role === "music" || s.role === "stinger"))
      lines.push(`${s.id}: ${p.info.bpm ? `${p.info.bpm} BPM` : "no steady beat"}, ${p.info.key ? `${p.info.key} (${p.info.camelot})` : "no clear key"}, ${p.info.seconds.toFixed(0)} s`);
  }
  return lines;
}
export function infoOf(file?: string) { return file ? (cache.get(`bed:${file}`) ?? cache.get(`fx:${file}`))?.info : undefined; }

// When several tracks fit the mood, pick the one that mixes best with what's playing (key first, then tempo)
export function pickCompatible(files: string[]): string | undefined {
  const cur = infoOf(beds.music?.file);
  if (!cur || files.length < 2) return files[0];
  const score = (f: string) => { const i = infoOf(f); return i ? keyDistance(cur.camelot, i.camelot) * 10 + tempoGap(cur.bpm, i.bpm) : 99; };
  return [...files].sort((a, b) => score(a) - score(b))[0];
}

// =====================================================================
// VOICES + fades
// =====================================================================
type Fade = { from: number; to: number; len: number; t: number; curve: "lin" | "in" | "out" };
type Voice = { buf: Float32Array; pos: number; gain: number; fade: Fade | null; loop: boolean; layer: string; dieAtZero: boolean; lpA?: number; lpY?: number; wet?: number; relFrom?: number; relLen?: number };
let voices: Voice[] = [];
const beds: Record<string, { voice: Voice | null; file: string; level: number; want?: number }> = {};
// BED BALANCE (mixer policy, so every caller gets it): `want` is what the caller asked for; the level actually played
// keeps the constant ambience UNDER the music (at most AMB_RATIO of it, and at most AMB_MAX before any music exists).
const AMB_RATIO = Number(process.env.MIX_AMB_RATIO ?? 0.6), AMB_MAX = 0.25;
const effectiveLevel = (layer: string, want: number) =>
  layer === "ambience" ? Math.min(want, beds.music?.want !== undefined ? beds.music.want * AMB_RATIO : AMB_MAX) : want;

// equal-power curves for crossfades (sin in / cos out keep the summed loudness constant);
// level glides use a smoothstep S-curve (no corner at the start or end, so changes are not heard as steps)
function fade(v: Voice, to: number, sec: number, curve: Fade["curve"] = "lin") {
  v.fade = { from: v.gain, to, len: Math.max(1, Math.round(sec * SR)), t: 0, curve };
}
function stepFade(v: Voice) {
  const f = v.fade!; f.t++;
  const u = Math.min(1, f.t / f.len);
  const w = f.curve === "in" ? Math.sin(u * Math.PI / 2) : f.curve === "out" ? 1 - Math.cos(u * Math.PI / 2) : u * u * (3 - 2 * u);
  v.gain = f.from + (f.to - f.from) * w;
  if (u >= 1) { v.gain = f.to; v.fade = null; }
}

// ducking: beds dip under your voice (-8 dB) and under each effect (-4 dB), smoothly
let duckSpeech = 1, duckFx = 1, lastSpeech = 0, fxUntil = 0;
export function speaking() { lastSpeech = Date.now(); }

// seconds until the next beat / bar of the music that's playing (null if it has no steady beat)
function untilNext(unit: "beat" | "bar"): number | null {
  const v = beds.music?.voice, info = infoOf(beds.music?.file);
  if (!v || !info?.bpm) return null;
  const beat = 60 / info.bpm, len = unit === "bar" ? beat * 4 : beat;
  const t = v.pos / SR - info.beatPhase;
  return ((len - (t % len)) + len) % len;
}

// =====================================================================
// PUBLIC API
// =====================================================================
const LOOKAHEAD_MS = 50; // beds start dipping this long BEFORE an effect is heard, so the effect never "pokes through"

// LOUDNESS + TREATMENT BY SCENE. `liftDb` = where the effect sits relative to the music bed playing right now: negative = tucked
// under it, 0 = merged, positive = standing out. `lowpassHz` darkens a sound (softens its edge) and `wet` is how much of the
// shared room it gets (more = further back, merged with the music). All chosen per sound by predict.ts from the sound's
// metadata and the scene; the mixer only applies them.
// Effects are normalised FX_DB and beds BED_DB, so gain = bed level * 10^((lift - (FX_DB - BED_DB)) / 20).
export function fxGainFor(liftDb: number, bedLevel?: number): number {
  const ref = bedLevel ?? beds.music?.level ?? beds.ambience?.level ?? 0.25;
  return Math.min(1, Math.max(0.02, ref) * dbToGain(liftDb - (FX_DB - BED_DB)));
}
let curDuckDb = FX_DUCK_DB;

export function playOnce(file: string | undefined, volume: number, opts: { role?: string; liftDb?: number; attackMs?: number; releaseMs?: number; maxS?: number; lowpassHz?: number; wet?: number } = {}): boolean {
  const p = prepare(file ?? "", "fx");
  if (!p || !running()) return false;
  let gain = opts.liftDb !== undefined ? fxGainFor(opts.liftDb) : Math.min(1, volume);
  // measured correction: a sharp clip was peak-limited when normalised and ends up quieter than a smooth one; add that
  // back: half of the deficit (short transients are heard louder than their RMS says), up to 8 dB, so "+6 dB over the music"
  // is what is heard for every clip, not just the smooth ones
  if (opts.liftDb !== undefined && p.prof) gain = Math.min(1, gain * dbToGain(Math.min(4, Math.max(0, -p.prof.levelDb * 0.5)))); // was up to 8 dB: sharp clips jumped out
  // the further an effect sits under/over the music, the less/more it pushes the music down
  const duckDb = opts.liftDb !== undefined ? FX_DUCK_DB * Math.min(1, Math.max(0.15, (opts.liftDb + 2) / 11)) : FX_DUCK_DB;
  const music = infoOf(beds.music?.file);
  // MONITOR: a tonal stinger in a clashing key would sound wrong over the music → play it quieter
  if (opts.role === "stinger" && p.info.tonal && music?.tonal && keyDistance(music.camelot, p.info.camelot) > 2) { // musical stingers only; real-world effects have no "key"
    gain *= dbToGain(-6);
    log(`stinger in ${p.info.key} clashes with the music (${music.key}) → played 6 dB quieter`);
  }
  // PLANNED LENGTH: a fetched clip much longer than the planner asked for is cut to about that length (a view, no copy) and
  // always gets a release so the cut is never heard
  const buf = opts.maxS && p.buf.length > opts.maxS * SR * 1.15 ? p.buf.subarray(0, Math.round(opts.maxS * SR)) : p.buf;
  const trimmed = buf !== p.buf;
  const go = () => {
    // duck first, then let the effect in a moment later
    fxUntil = Math.max(fxUntil, Date.now() + LOOKAHEAD_MS + Math.min(buf.length / SR, FX_DUCK_MAX_S) * 1000);
    curDuckDb = duckDb;
    const seconds = buf.length / SR;
    const attack = Math.min(opts.attackMs ?? 0, seconds * 400); // never more than 40% of what is played
    const release = Math.max(opts.releaseMs ?? 0, trimmed ? 220 : 0);
    setTimeout(() => {
      const v: Voice = { buf, pos: 0, gain: attack > 12 ? 0 : gain, fade: null, loop: false, layer: "fx", dieAtZero: false, wet: opts.wet ?? 1 };
      if (opts.lowpassHz && opts.lowpassHz < 16000) { v.lpA = 1 - Math.exp((-2 * Math.PI * opts.lowpassHz) / SR); v.lpY = 0; } // softer edge
      if (attack > 12) fade(v, gain, attack / 1000, "in"); // soft entry for background texture
      // release: the last `release` ms fade out on a smooth curve (never longer than 60% of what is played), so a sound
      // that sits back in the scene dissolves into the music instead of stopping
      if (release > 130) {
        v.relLen = Math.min(Math.round((release / 1000) * SR), Math.round(buf.length * 0.6));
        v.relFrom = buf.length - v.relLen;
      }
      voices.push(v);
    }, LOOKAHEAD_MS);
  };
  // stingers land on the beat if the next one is close (≤ 0.3 s); real-world effects play immediately
  const wait = opts.role === "stinger" ? untilNext("beat") : null;
  if (wait !== null && wait <= 0.3) { setTimeout(go, Math.max(0, wait * 1000 - LOOKAHEAD_MS)); log(`stinger placed on the next beat (+${Math.round(wait * 1000)} ms)`); }
  else go();
  return true;
}

export function setLoop(layer: "music" | "ambience", file: string | undefined, volume: number) {
  const bed = beds[layer] ?? (beds[layer] = { voice: null, file: "", level: 0 });
  const want = volume;
  bed.want = want; volume = effectiveLevel(layer, want);
  if (layer === "music") applyLevel("ambience"); // an ambience already running re-balances against this music
  if (bed.file === (file ?? "") && bed.voice) return setLevel(layer, want);
  const p = prepare(file ?? "", "bed");
  const prevInfo = infoOf(bed.file);
  // MONITOR the transition like a DJ: tempo gap, key compatibility → choose crossfade length
  let xfade = 4;
  if (layer === "music" && p && prevInfo && bed.voice) {
    const gap = tempoGap(prevInfo.bpm, p.info.bpm), kd = keyDistance(prevInfo.camelot, p.info.camelot);
    const keyOk = kd <= 1;
    xfade = keyOk && gap < 6 ? 4 : 6; // clashing key or tempo → longer, gentler blend so they don't fight
    log(`music ${prevInfo.key || "?"} ${prevInfo.bpm || "?"} BPM → ${p.info.key || "?"} ${p.info.bpm || "?"} BPM: ` +
      `${keyOk ? "keys compatible" : `keys ${kd} steps apart`}, tempo gap ${gap.toFixed(0)}% → ${xfade} s equal-power crossfade`);
  }
  const doSwitch = () => {
    if (bed.voice) { bed.voice.dieAtZero = true; fade(bed.voice, 0, xfade, "out"); }
    bed.file = file ?? ""; bed.level = volume; bed.voice = null;
    if (!p || !running()) return;
    // start the new track ON its first beat, so its beats line up with the bar we switched on (beat-matched entry)
    const startAt = layer === "music" && p.info.bpm ? Math.round(p.info.beatPhase * SR) : 0;
    const v: Voice = { buf: p.buf, pos: startAt, gain: 0, fade: null, loop: true, layer, dieAtZero: false };
    fade(v, volume, xfade, "in");
    voices.push(v);
    bed.voice = v;
  };
  // music changes wait for the next bar of the current track (if it has a beat and the bar is ≤ 4 s away)
  const wait = layer === "music" && bed.voice ? untilNext("bar") : null;
  if (wait !== null && wait <= 4) { log(`switch waits ${wait.toFixed(1)} s for the next bar`); setTimeout(doSwitch, wait * 1000); }
  else doSwitch();
}

export function setLevel(layer: "music" | "ambience", want: number) {
  const bed = beds[layer];
  if (bed) bed.want = want;
  applyLevel(layer);
  if (layer === "music") applyLevel("ambience"); // the ambience follows the music it sits under
}
function applyLevel(layer: string) {
  const bed = beds[layer];
  if (!bed?.voice || bed.want === undefined) return;
  const volume = effectiveLevel(layer, bed.want);
  if (Math.abs(bed.level - volume) < 0.02) return; // tiny moves aren't worth a new glide
  bed.level = volume;
  fade(bed.voice, volume, 2.5, "lin"); // slow S-curve glide, never restart
}

let timer: ReturnType<typeof setInterval> | null = null;
export function stopAll() {
  for (const v of voices) { v.dieAtZero = true; fade(v, 0, 0.5, "out"); }
  setTimeout(() => { if (timer) clearInterval(timer); out?.stdin?.end(); if (OUT_FILE) flushFile(); out = null; }, 700);
}

// =====================================================================
// MIX LOOP: ~20 ms blocks, kept ~150 ms ahead of real time
// =====================================================================
const LEAD = Number(process.env.MIX_LEAD || 0.12); // seconds kept queued ahead of real time
let out: ChildProcess | null = null;
let started = 0, sent = 0;
const fileChunks: Buffer[] = [];
function running(): boolean {
  if (timer) return true;
  if (!DECODER || !OUTPUT) return false;
  const fmt = ["-t", "raw", "-r", String(SR), "-e", "floating-point", "-b", "32", "-c", "1", "-"];
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const devArg = process.env.OUT_DEVICE ? `-t coreaudio ${q(process.env.OUT_DEVICE)}` : "-d";
  // `cat |` matters: sox reading Node's socket stdin directly saw EOF after the first chunk and exited (silence)
  if (OUTPUT === "sox") out = spawn("sh", ["-c", `cat | sox --buffer ${Number(process.env.SOX_BUFFER) || 8192} -q ${fmt.join(" ")} ${devArg}`], { stdio: ["pipe", "ignore", "pipe"] });
  else if (OUTPUT === "ffplay") out = spawn("ffplay", ["-nodisp", "-loglevel", "error", "-f", "f32le", "-ar", String(SR), "-ac", "1", "-"], { stdio: ["pipe", "ignore", "pipe"] });
  let errText = "";
  out?.stderr?.on("data", d => { errText += String(d); if (errText.length < 400) log(`audio output error: ${String(d).trim()}`); });
  out?.on("exit", code => { if (code) log(`audio output stopped (exit ${code}) ${errText.trim().slice(0, 200)}`); });
  out?.on("error", e => log(`audio output could not start: ${e.message}`));
  out?.on("error", () => { });
  out?.stdin?.on("error", () => { });
  started = Date.now(); sent = 0;
  timer = setInterval(tick, 10);
  return true;
}

// Small shared "room" for effects (4 damped combs + 2 allpasses): glues effects to the music so they sound like
// they happen in the same space instead of being pasted on top
const combs = [1557, 1617, 1491, 1422].map(n => ({ b: new Float32Array(n), i: 0, lp: 0 }));
const aps = [225, 556].map(n => ({ b: new Float32Array(n), i: 0 }));
// The SPACE of the scene (decided by Claude in the slow loop, see setSpace): how long the room rings and how much of it is
// heard. The values glide, so a change of place is a smooth transition, not a jump.
const SPACES: Record<string, { fb: number; wet: number }> = {
  room: { fb: 0.74, wet: 0.12 }, hall: { fb: 0.84, wet: 0.2 }, cave: { fb: 0.89, wet: 0.3 }, outdoors: { fb: 0.6, wet: 0.06 },
};
const space = { fb: 0.74, wet: 0.12, fbT: 0.74, wetT: 0.12, name: "room" };
export function setSpace(name: string) {
  const s = SPACES[name];
  if (!s || name === space.name) return;
  space.name = name; space.fbT = s.fb; space.wetT = s.wet;
  log(`space → ${name} (room ${s.fb}, wet ${s.wet})`);
}
const AMBIENCE_SEND = 0.35; // the place's own background sound goes through the same room as the effects
function room(x: number): number {
  let y = 0;
  for (const c of combs) {
    const d = c.b[c.i];
    c.lp = d * 0.7 + c.lp * 0.3;           // damping: tails get darker, like a real room
    c.b[c.i] = x + c.lp * space.fb;
    c.i = (c.i + 1) % c.b.length;
    y += d;
  }
  y *= 0.25;
  for (const a of aps) {
    const d = a.b[a.i];
    a.b[a.i] = y + d * 0.5;
    a.i = (a.i + 1) % a.b.length;
    y = -y + d;
  }
  return y;
}

function tick() {
  const want = Math.floor(((Date.now() - started) / 1000 + LEAD) * SR) - sent;
  if (want <= 0) return;
  const block = new Float32Array(want);
  const now = Date.now();
  const speechTarget = now - lastSpeech < 600 ? dbToGain(-8) : 1;
  const fxTarget = now < fxUntil ? dbToGain(curDuckDb) : 1;
  for (let i = 0; i < want; i++) {
    duckSpeech += (speechTarget - duckSpeech) * (speechTarget < duckSpeech ? 0.0005 : 0.0001); // ~50 ms down, ~250 ms up
    duckFx += (fxTarget - duckFx) * (fxTarget < duckFx ? 0.0004 : 0.00004);                      // dips in ~60 ms, swells back over ~0.6 s (no audible "hole")
    const bedDuck = duckSpeech * duckFx;
    if ((i & 1023) === 0) { space.fb += (space.fbT - space.fb) * 0.02; space.wet += (space.wetT - space.wet) * 0.02; } // ~2 s glide
    let bedSum = 0, fxSum = 0, wetSum = 0;
    for (const v of voices) {
      if (v.fade) stepFade(v);
      if (v.pos >= v.buf.length) { if (!v.loop) continue; v.pos = 0; }
      if (v.layer === "fx") {
        let s = v.buf[v.pos++];
        if (v.lpA !== undefined) { v.lpY! += v.lpA * (s - v.lpY!); s = v.lpY!; }
        if (v.relFrom !== undefined && v.pos > v.relFrom) { const u = (v.pos - v.relFrom) / v.relLen!; s *= Math.cos(Math.min(1, u) * Math.PI / 2); } // equal-power release
        s *= v.gain; fxSum += s; wetSum += s * (v.wet ?? 1);
      }
      else {
        const s = v.buf[v.pos++] * v.gain * bedDuck;
        bedSum += s;
        if (v.layer === "ambience") wetSum += s * AMBIENCE_SEND;
      }
    }
    block[i] = Math.tanh(bedSum + fxSum + room(wetSum) * space.wet); // soft limiter: overlapping sounds never hard-clip
  }
  voices = voices.filter(v => (v.loop || v.pos < v.buf.length) && !(v.dieAtZero && v.gain === 0 && !v.fade));
  sent += want;
  const buf = Buffer.from(block.buffer);
  if (OUT_FILE) fileChunks.push(buf); else out?.stdin?.write(buf);
}

function flushFile() {
  const data = Buffer.concat(fileChunks);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(OUT_FILE, Buffer.concat([h, data]));
}
