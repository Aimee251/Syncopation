// @ts-check
// room/clock.js — the timing maths for speaker rooms (spec §7, §9). Pure functions, no I/O.
// Plain JS on purpose: the server, the phone page (loaded as an ES module, no bundler) and the tests
// all import this one file, so the scheduling decision a test checks is the one the phone makes.
//
// Clock domains, never mixed without a mapping:
//   server ms   performance.now() on the server (monotonic, since process start; serverEpochId changes on restart)
//   client ms   performance.now() in the browser
//   audio s     AudioContext.currentTime (what AudioBufferSourceNode.start() takes)

/** @typedef {{ c0: number, s1: number, s2: number, c3: number }} SyncSample */
/** @typedef {{ offsetMs: number, rttMs: number }} SyncMeasure */
/** @typedef {{ offsetMs: number, rttMs: number, uncertaintyMs: number, samples: number, measuredAtMs: number }} ClockEstimate */

const finite = (/** @type {unknown[]} */ ...xs) => xs.every(x => typeof x === "number" && Number.isFinite(x));

/**
 * One request/response exchange → server-minus-client offset and network round trip.
 * Returns null for a measurement that can't be right (clocks going backwards, negative round trip).
 * @param {SyncSample} s
 * @returns {SyncMeasure | null}
 */
export function measure({ c0, s1, s2, c3 }) {
  if (!finite(c0, s1, s2, c3) || c3 < c0 || s2 < s1) return null;
  const rttMs = (c3 - c0) - (s2 - s1);
  if (rttMs < 0) return null;
  return { offsetMs: ((s1 - c0) + (s2 - c3)) / 2, rttMs };
}

/**
 * Robust offset from several exchanges: only the fastest round trips are trusted (a slow exchange was
 * probably queued on one leg, which skews its offset), then the median offset of those.
 * uncertaintyMs = half the best round trip (the most network asymmetry could hide) plus the spread of the kept offsets.
 * @param {SyncSample[]} samples
 * @param {number} nowClientMs when the estimate is made (client ms), for freshness checks
 * @param {{ keepFraction?: number, minKeep?: number }} [opts]
 * @returns {ClockEstimate | null}
 */
export function estimateOffset(samples, nowClientMs, { keepFraction = 0.5, minKeep = 3 } = {}) {
  const ok = /** @type {SyncMeasure[]} */ (samples.map(measure).filter(Boolean)).sort((a, b) => a.rttMs - b.rttMs);
  if (!ok.length) return null;
  const kept = ok.slice(0, Math.min(ok.length, Math.max(minKeep, Math.ceil(ok.length * keepFraction))));
  const offsets = kept.map(m => m.offsetMs).sort((a, b) => a - b);
  const offsetMs = median(offsets);
  const spread = median(offsets.map(o => Math.abs(o - offsetMs)));
  return { offsetMs, rttMs: kept[0].rttMs, uncertaintyMs: kept[0].rttMs / 2 + spread, samples: kept.length, measuredAtMs: nowClientMs };
}

/** @param {number[]} sorted */
function median(sorted) {
  const s = [...sorted].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * An estimate is usable only while it is recent and tight enough for the scheduling lead.
 * @param {ClockEstimate | null | undefined} est
 * @param {number} nowClientMs
 * @param {{ maxAgeMs?: number, maxUncertaintyMs?: number }} [opts]
 */
export function isFresh(est, nowClientMs, { maxAgeMs = 15_000, maxUncertaintyMs = 100 } = {}) {
  return !!est && nowClientMs - est.measuredAtMs <= maxAgeMs && est.uncertaintyMs <= maxUncertaintyMs;
}

/** serverNowMs = performance.now() + offsetMs */
export const serverNow = (/** @type {number} */ clientNowMs, /** @type {number} */ offsetMs) => clientNowMs + offsetMs;

/**
 * Server target time → AudioContext time.
 * deviceAdvanceMs > 0 starts earlier, to make up for a phone whose output path is slower.
 * @param {{ playAtServerMs: number, serverNowMs: number, audioNow: number, deviceAdvanceMs?: number }} p
 */
export function toAudioTime({ playAtServerMs, serverNowMs, audioNow, deviceAdvanceMs = 0 }) {
  return audioNow + (playAtServerMs - serverNowMs) / 1000 - deviceAdvanceMs / 1000;
}

/**
 * Where a loop is after `elapsedS` of playback that began at `offsetSeconds` into the file.
 * Before loopEnd it just plays through; after that it wraps inside [loopStart, loopEnd).
 * @param {{ elapsedS: number, offsetSeconds?: number, durationS: number, loopStartSeconds?: number, loopEndSeconds?: number }} p
 */
export function loopPhase({ elapsedS, offsetSeconds = 0, durationS, loopStartSeconds = 0, loopEndSeconds }) {
  const end = loopEndSeconds ?? durationS;
  const len = end - loopStartSeconds;
  const pos = offsetSeconds + Math.max(0, elapsedS);
  if (pos < end || len <= 0) return Math.min(pos, end);
  return loopStartSeconds + ((pos - loopStartSeconds) % len);
}

/**
 * What a phone does with a cue right now (spec §7 and §9).
 *   one-shot on time   → start at its audio time
 *   one-shot too late  → skip (never a delayed burst of thunder)
 *   loop on time       → start at its audio time, at its own offset
 *   loop too late      → join at the CURRENT phase a safe margin from now, fading in (never from the beginning)
 * "Too late" = the corrected start is less than safetyMarginMs in the future.
 * @param {{
 *   playAtServerMs: number, serverNowMs: number, audioNow: number, deviceAdvanceMs?: number, safetyMarginMs?: number,
 *   loop?: boolean, offsetSeconds?: number, durationS?: number, loopStartSeconds?: number, loopEndSeconds?: number,
 *   anchorServerMs?: number,
 * }} p
 * @returns {{ action: "start", when: number, offset: number, joined: boolean } | { action: "skip", lateMs: number }}
 */
export function scheduleCue(p) {
  const { serverNowMs, audioNow, deviceAdvanceMs = 0, safetyMarginMs = 50, offsetSeconds = 0 } = p;
  const when = toAudioTime(p);
  const leadMs = (when - audioNow) * 1000;
  const anchor = p.anchorServerMs ?? p.playAtServerMs;
  if (leadMs >= safetyMarginMs) {
    // a loop restarted later than its anchor (Resume) starts where the timeline is by then, not at the top
    const offset = p.loop && anchor < p.playAtServerMs && finite(p.durationS)
      ? loopPhase({ elapsedS: (p.playAtServerMs - anchor) / 1000, offsetSeconds, durationS: /** @type {number} */ (p.durationS), loopStartSeconds: p.loopStartSeconds, loopEndSeconds: p.loopEndSeconds })
      : offsetSeconds;
    return { action: "start", when, offset, joined: false };
  }
  if (!p.loop) return { action: "skip", lateMs: safetyMarginMs - leadMs };
  if (!finite(p.durationS)) return { action: "skip", lateMs: safetyMarginMs - leadMs };
  // join the loop where everyone else is: phase measured from the ORIGINAL anchor, at a time we can still meet
  const joinAtServerMs = serverNowMs + deviceAdvanceMs + safetyMarginMs;
  const offset = loopPhase({
    elapsedS: (joinAtServerMs - anchor) / 1000, offsetSeconds, durationS: /** @type {number} */ (p.durationS),
    loopStartSeconds: p.loopStartSeconds, loopEndSeconds: p.loopEndSeconds,
  });
  return { action: "start", when: toAudioTime({ playAtServerMs: joinAtServerMs, serverNowMs, audioNow, deviceAdvanceMs }), offset, joined: true };
}
