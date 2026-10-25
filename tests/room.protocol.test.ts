import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClientMessage, parseServerMessage, MAX_MESSAGE_BYTES } from "../room/protocol.js";

const m = (type: string, body: object = {}) => JSON.stringify({ protocolVersion: 1, type, ...body });

test("six-digit codes keep their leading zeros and must be strings", () => {
  assert.equal(parseClientMessage(m("room.join", { code: "004213" })).ok, true);
  for (const code of ["4213", "0042130", "12345a", 4213, 123456, " 123456"]) assert.equal(parseClientMessage(m("room.join", { code })).ok, false, String(code));
});

test("envelope, size, unknown types and unknown fields are rejected", () => {
  assert.equal(parseClientMessage("{nope").ok, false);
  assert.equal(parseClientMessage(JSON.stringify({ type: "member.leave" })).ok, false);                  // no protocolVersion
  assert.equal(parseClientMessage(JSON.stringify({ protocolVersion: 2, type: "member.leave" })).ok, false);
  assert.equal(parseClientMessage(m("cue.play")).ok, false);                                             // server-only type
  assert.equal(parseClientMessage(m("member.leave", { extra: 1 })).ok, false);
  assert.equal(parseClientMessage(m("room.join", { code: "123456", displayName: "x".repeat(MAX_MESSAGE_BYTES) })).ok, false);
});

test("numbers must be finite and in range; enums must match", () => {
  assert.equal(parseClientMessage(m("sync.request", { requestId: 1, c0: 12.5 })).ok, true);
  assert.equal(parseClientMessage('{"protocolVersion":1,"type":"sync.request","requestId":1,"c0":1e999}').ok, false); // Infinity
  assert.equal(parseClientMessage(m("sync.request", { requestId: -1, c0: 1 })).ok, false);
  const ready = { manifestVersion: 1, loadedAssetIds: ["thunder_0"], audioState: "running", snapshotApplied: true };
  assert.equal(parseClientMessage(m("member.ready", ready)).ok, true);
  assert.equal(parseClientMessage(m("member.ready", { ...ready, audioState: "loud" })).ok, false);
  assert.equal(parseClientMessage(m("member.ready", { ...ready, loadedAssetIds: ["../etc/passwd"] })).ok, false);
  assert.equal(parseClientMessage(m("member.status", { skipped: { cueId: "c", reason: "late" } })).ok, true);
  assert.equal(parseClientMessage(m("member.status", { skipped: { cueId: "c", reason: "bored" } })).ok, false);
});

test("phones check cue payloads before scheduling them", () => {
  const cue = {
    roomId: "r", serverEpochId: "e", generation: 3, sequence: 42, cueId: "c", assetId: "thunder_0", contentHash: "h", layerId: "sfx",
    playAtServerMs: 125_400, offsetSeconds: 0, loop: false, gain: 0.65, fadeInMs: 10, fadeOutMs: 100, latePolicy: "skip", durationS: 2,
  };
  assert.equal(parseServerMessage(m("cue.play", cue)).ok, true);
  assert.equal(parseServerMessage(m("cue.play", { ...cue, gain: 2 })).ok, false);
  assert.equal(parseServerMessage(m("cue.play", { ...cue, generation: 1.5 })).ok, false);
  assert.equal(parseServerMessage(m("cue.play", { ...cue, sequence: undefined })).ok, false);
  assert.equal(parseServerMessage(m("room.closed", { reason: "ended" })).ok, true);
  assert.equal(parseServerMessage(m("made.up")).ok, false);
});
