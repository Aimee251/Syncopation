// Clock maths with synthetic offsets, latency, jitter and late cues (spec §11 "Automated timing").
import { test } from "node:test";
import assert from "node:assert/strict";
import { measure, estimateOffset, isFresh, toAudioTime, loopPhase, scheduleCue } from "../room/clock.js";

/** One exchange with a known true offset (server = client + offset) and given one-way delays. */
function exchange(c0: number, offset: number, upMs: number, downMs: number, processMs = 1) {
  const s1 = c0 + upMs + offset, s2 = s1 + processMs;
  return { c0, s1, s2, c3: s2 - offset + downMs };
}

test("symmetric delay recovers the exact offset and round trip", () => {
  const m = measure(exchange(100, 1000, 20, 20, 2))!;
  assert.equal(m.offsetMs, 1000);
  assert.equal(m.rttMs, 40);
});

test("asymmetric delay errs by at most half the round trip", () => {
  const m = measure(exchange(100, -5000, 5, 45))!;
  assert.ok(Math.abs(m.offsetMs - -5000) <= m.rttMs / 2);
});

test("impossible measurements are rejected", () => {
  assert.equal(measure({ c0: 100, s1: 5, s2: 6, c3: 90 }), null);       // client clock went backwards
  assert.equal(measure({ c0: 100, s1: 9, s2: 5, c3: 120 }), null);      // server clock went backwards
  assert.equal(measure({ c0: 100, s1: 0, s2: 100, c3: 110 }), null);    // server held it longer than the round trip
  assert.equal(measure({ c0: NaN, s1: 1, s2: 2, c3: 3 }), null);
  assert.equal(estimateOffset([{ c0: NaN, s1: 1, s2: 2, c3: 3 }], 0), null);
});

test("slow, skewed exchanges are ignored in favour of the fastest ones", () => {
  const truth = 123_456;
  const samples = [
    ...Array.from({ length: 7 }, (_, i) => exchange(i * 100, truth, 10, 10)),
    exchange(800, truth, 300, 10), exchange(900, truth, 10, 400), exchange(1000, truth, 250, 250), // queued on one leg
  ];
  const est = estimateOffset(samples, 1100)!;
  assert.ok(Math.abs(est.offsetMs - truth) < 0.5, `offset ${est.offsetMs}`);
  assert.equal(est.rttMs, 20);
  assert.ok(est.uncertaintyMs < 15);
});

test("jittery network: the estimate stays within its own uncertainty", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let run = 0; run < 50; run++) {
    const truth = (rand() - 0.5) * 1e7;
    const samples = Array.from({ length: 10 }, (_, i) => exchange(i * 50, truth, 5 + rand() * 80, 5 + rand() * 80));
    const est = estimateOffset(samples, 600)!;
    assert.ok(Math.abs(est.offsetMs - truth) <= est.uncertaintyMs, `run ${run}: err ${Math.abs(est.offsetMs - truth)} > ${est.uncertaintyMs}`);
  }
});

test("freshness: too old or too uncertain is not usable", () => {
  const est = { offsetMs: 0, rttMs: 20, uncertaintyMs: 10, samples: 5, measuredAtMs: 1000 };
  assert.equal(isFresh(est, 5000), true);
  assert.equal(isFresh(est, 1000 + 15_001), false);
  assert.equal(isFresh({ ...est, uncertaintyMs: 150 }, 1000), false);
  assert.equal(isFresh(null, 0), false);
});

test("server time maps into the audio clock, device advance starts earlier", () => {
  assert.equal(toAudioTime({ playAtServerMs: 10_400, serverNowMs: 10_000, audioNow: 5 }), 5.4);
  assert.ok(Math.abs(toAudioTime({ playAtServerMs: 10_400, serverNowMs: 10_000, audioNow: 5, deviceAdvanceMs: 30 }) - 5.37) < 1e-9);
});

test("one-shot on time starts; one-shot too late is skipped, never played late", () => {
  const on = scheduleCue({ playAtServerMs: 10_400, serverNowMs: 10_000, audioNow: 2 });
  assert.deepEqual(on, { action: "start", when: 2.4, offset: 0, joined: false });
  const late = scheduleCue({ playAtServerMs: 10_400, serverNowMs: 10_380, audioNow: 2, safetyMarginMs: 50 });
  assert.equal(late.action, "skip");
  assert.ok(late.action === "skip" && Math.abs(late.lateMs - 30) < 1e-9);
});

test("a late loop joins at the current phase from its original anchor", () => {
  const r = scheduleCue({ playAtServerMs: 10_000, anchorServerMs: 10_000, serverNowMs: 13_000, audioNow: 7, loop: true, durationS: 4, safetyMarginMs: 50 });
  assert.equal(r.action, "start");
  if (r.action !== "start") return;
  assert.equal(r.joined, true);
  assert.ok(Math.abs(r.offset - 3.05) < 1e-9, `offset ${r.offset}`);
  assert.ok(Math.abs(r.when - 7.05) < 1e-9);
  // 2 s further on it has wrapped: (5.05) mod 4 = 1.05
  const r2 = scheduleCue({ playAtServerMs: 10_000, serverNowMs: 15_000, audioNow: 9, loop: true, durationS: 4, safetyMarginMs: 50 });
  assert.ok(r2.action === "start" && Math.abs(r2.offset - 1.05) < 1e-9);
});

test("a loop resumed in the future starts at its timeline position, not from the top", () => {
  // anchored at 10 s, resumed for 25.4 s: 15.4 s into a 4 s loop → 3.4 s
  const r = scheduleCue({ playAtServerMs: 25_400, anchorServerMs: 10_000, serverNowMs: 25_000, audioNow: 1, loop: true, durationS: 4 });
  assert.ok(r.action === "start" && !r.joined && Math.abs(r.offset - 3.4) < 1e-9 && Math.abs(r.when - 1.4) < 1e-9);
  // a fresh loop (anchor = play time) still starts at its own offset
  const f = scheduleCue({ playAtServerMs: 25_400, anchorServerMs: 25_400, serverNowMs: 25_000, audioNow: 1, loop: true, durationS: 4, offsetSeconds: 0.5 });
  assert.ok(f.action === "start" && f.offset === 0.5);
});

test("a late loop with device advance still lands on the right phase", () => {
  const r = scheduleCue({ playAtServerMs: 0, serverNowMs: 1000, audioNow: 3, loop: true, durationS: 10, safetyMarginMs: 50, deviceAdvanceMs: 40 });
  assert.ok(r.action === "start");
  if (r.action !== "start") return;
  assert.ok(Math.abs(r.when - 3.05) < 1e-9);          // scheduled the margin ahead
  assert.ok(Math.abs(r.offset - 1.09) < 1e-9);        // heard 40 ms after scheduling → phase at 1090 ms
});

test("loop phase with non-zero loop boundaries and an initial offset", () => {
  assert.equal(loopPhase({ elapsedS: 3, durationS: 10, loopStartSeconds: 2, loopEndSeconds: 6 }), 3);  // intro, not looped yet
  assert.equal(loopPhase({ elapsedS: 9, durationS: 10, loopStartSeconds: 2, loopEndSeconds: 6 }), 5);  // 2 + (7 mod 4)
  assert.equal(loopPhase({ elapsedS: 1, offsetSeconds: 5.5, durationS: 10, loopStartSeconds: 2, loopEndSeconds: 6 }), 2.5);
  assert.equal(loopPhase({ elapsedS: -3, durationS: 4 }), 0);
});
