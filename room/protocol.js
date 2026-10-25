// @ts-check
// room/protocol.js — the speaker-room message contract (spec §8) and its validation, shared by the server and the phone page.
// Every message is JSON with { protocolVersion, type }. Room events also carry roomId, serverEpochId, generation and sequence.
// Validation is hand-written (the repo has no schema library): exact types, bounded strings and arrays, finite numbers, known enums.
// Host controls are named host.* so they can't be confused with the room.* events the server broadcasts.

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const CODE_RE = /^\d{6}$/; // six digits, leading zeros kept: always a string, never a number

export const MEMBER_STATES = /** @type {const} */ (["enabling_sound", "loading", "synchronizing", "ready", "degraded", "disconnected"]);
export const AUDIO_STATES = /** @type {const} */ (["running", "suspended", "closed", "interrupted"]);
export const SKIP_REASONS = /** @type {const} */ (["late", "missing_asset", "not_ready", "muted", "decode_failed", "stale_generation"]);
export const LATE_POLICIES = /** @type {const} */ (["skip", "join"]);
export const CLOSE_REASONS = /** @type {const} */ (["ended", "removed", "expired", "idle", "host_timeout", "server_restart"]);
export const ERROR_CODES = /** @type {const} */ ([
  "bad_message", "unauthorized", "invalid_code", "room_full", "room_locked", "rate_limited", "unknown_asset", "not_found", "create_forbidden",
]);

// ---- tiny schema helpers: each returns an error string or "" ----
/** @typedef {(v: unknown) => string} Check */
const str = (/** @type {number} */ max, min = 1) => /** @type {Check} */ (v => typeof v === "string" && v.length >= min && v.length <= max ? "" : `string ${min}..${max}`);
const num = (lo = -Infinity, hi = Infinity) => /** @type {Check} */ (v => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? "" : `finite number ${lo}..${hi}`);
const int = (lo = 0, hi = Number.MAX_SAFE_INTEGER) => /** @type {Check} */ (v => Number.isSafeInteger(v) && /** @type {number} */ (v) >= lo && /** @type {number} */ (v) <= hi ? "" : `integer ${lo}..${hi}`);
const bool = /** @type {Check} */ (v => typeof v === "boolean" ? "" : "boolean");
const oneOf = (/** @type {readonly string[]} */ xs) => /** @type {Check} */ (v => typeof v === "string" && xs.includes(v) ? "" : `one of ${xs.join("|")}`);
const re = (/** @type {RegExp} */ r) => /** @type {Check} */ (v => typeof v === "string" && r.test(v) ? "" : `match ${r}`);
const arr = (/** @type {Check} */ item, max = 500) => /** @type {Check} */ (v => {
  if (!Array.isArray(v) || v.length > max) return `array of at most ${max}`;
  for (let i = 0; i < v.length; i++) { const e = item(v[i]); if (e) return `[${i}] ${e}`; }
  return "";
});
const opt = (/** @type {Check} */ c) => /** @type {Check} */ (v => (v === undefined ? "" : c(v)));
/** @param {Record<string, Check>} shape  extra keys are rejected, so a typo can't pass silently */
const obj = shape => /** @type {Check} */ (v => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "object";
  const o = /** @type {Record<string, unknown>} */ (v);
  for (const k of Object.keys(o)) if (!(k in shape)) return `unexpected field ${k}`;
  for (const [k, c] of Object.entries(shape)) { const e = c(o[k]); if (e) return `${k}: ${e}`; }
  return "";
});

const ID = str(64);
const ASSET_ID = re(/^[A-Za-z0-9_.:#-]{1,96}$/);
const clockDiag = obj({ offsetMs: num(), uncertaintyMs: num(0), rttMs: num(0), ageMs: num(0) });

/** Messages a client may send. Which role may send which is decided by the server, not here. */
export const CLIENT_SCHEMAS = /** @type {Record<string, Record<string, Check>>} */ ({
  "room.create": { name: opt(str(40)), pack: opt(str(64)) },
  "room.join": { code: re(CODE_RE), displayName: opt(str(32)) },
  "room.auth": { token: re(/^[A-Za-z0-9_-]{20,100}$/) },
  "sync.request": { requestId: int(0), c0: num() },
  "member.ready": {
    manifestVersion: int(0), loadedAssetIds: arr(ASSET_ID), audioState: oneOf(AUDIO_STATES), snapshotApplied: bool, clock: opt(clockDiag),
  },
  "member.status": {
    state: opt(oneOf(MEMBER_STATES)), audioState: opt(oneOf(AUDIO_STATES)), clock: opt(clockDiag),
    lateCues: opt(int(0)), skipped: opt(obj({ cueId: ID, reason: oneOf(SKIP_REASONS) })),
  },
  "member.leave": {},
  "snapshot.request": {},
  "host.mute": { reason: opt(str(64)) },
  "host.resume": {},
  "host.lock": { locked: bool },
  "host.remove": { memberId: ID },
  "host.end": {},
  "host.start": {},
  "host.test": { assetId: opt(ASSET_ID) },
  // the talk run on the server (room/talks.ts)
  "host.setup": { theme: str(200), minutes: opt(num(1, 120)), sounds: opt(str(300, 0)) },
  "host.useSession": { sessionId: re(/^[a-z0-9_]{1,64}$/) },
  "host.say": { text: str(1000) },
  "host.command": { command: oneOf(["skip", "good", "end", "status"]) },
});

/**
 * Parse and check one incoming client message.
 * @param {string | Buffer | ArrayBuffer} raw
 * @returns {{ ok: true, msg: Record<string, any> & { type: string } } | { ok: false, error: string }}
 */
export function parseClientMessage(raw) {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(/** @type {any} */ (raw));
  if (byteLength(text) > MAX_MESSAGE_BYTES) return { ok: false, error: "message too large" };
  let msg;
  try { msg = JSON.parse(text); } catch { return { ok: false, error: "not JSON" }; }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { ok: false, error: "not an object" };
  if (msg.protocolVersion !== PROTOCOL_VERSION) return { ok: false, error: `protocolVersion must be ${PROTOCOL_VERSION}` };
  const shape = CLIENT_SCHEMAS[msg.type];
  if (!shape) return { ok: false, error: `unknown type ${String(msg.type).slice(0, 40)}` };
  const { protocolVersion, type, ...body } = msg;
  const e = obj(shape)(body);
  return e ? { ok: false, error: `${type}: ${e}` } : { ok: true, msg };
}

const byteLength = (/** @type {string} */ s) => new TextEncoder().encode(s).length;

// ---- server → client: what the phone checks before acting on it ----
const roomEvent = { roomId: ID, serverEpochId: ID, generation: int(0), sequence: int(0) };
const cueFields = {
  ...roomEvent, cueId: ID, assetId: ASSET_ID, contentHash: str(128), layerId: ID, playAtServerMs: num(0), offsetSeconds: num(0),
  loop: bool, gain: num(0, 1), fadeInMs: num(0, 60_000), fadeOutMs: num(0, 60_000), latePolicy: oneOf(LATE_POLICIES),
  durationS: opt(num(0)), maxS: opt(num(0)), loopStartSeconds: opt(num(0)), loopEndSeconds: opt(num(0)), anchorServerMs: opt(num(0)),
};
/** Only the events a phone acts on are checked strictly; others (room.members for the host, errors) just need a known type. */
export const SERVER_SCHEMAS = /** @type {Record<string, Record<string, Check> | null>} */ ({
  "room.created": null, "room.joined": null, "sync.response": null, "room.members": null, "error": null, "assets.manifest": null, "room.snapshot": null,
  "talk.status": null,
  "cue.play": cueFields,
  "cue.stop": { ...roomEvent, cueId: opt(ID), layerId: opt(ID), stopAtServerMs: num(0), fadeOutMs: num(0, 60_000) },
  "layer.gain": { ...roomEvent, layerId: ID, gain: num(0, 1), atServerMs: num(0), rampMs: num(0, 60_000) },
  "layer.duck": { ...roomEvent, atServerMs: num(0), depth: num(0, 1), holdMs: num(0, 60_000) },
  "room.mute": { ...roomEvent, muted: bool, reason: str(64) },
  "room.resume": null,
  "room.closed": { reason: oneOf(CLOSE_REASONS) },
});

/**
 * @param {string} text
 * @returns {{ ok: true, msg: Record<string, any> & { type: string } } | { ok: false, error: string }}
 */
export function parseServerMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return { ok: false, error: "not JSON" }; }
  if (!msg || typeof msg !== "object" || msg.protocolVersion !== PROTOCOL_VERSION) return { ok: false, error: "bad envelope" };
  if (!(msg.type in SERVER_SCHEMAS)) return { ok: false, error: `unknown type ${String(msg.type).slice(0, 40)}` };
  const shape = SERVER_SCHEMAS[msg.type];
  if (shape) {
    const { protocolVersion, type, ...body } = msg;
    const e = obj(shape)(body);
    if (e) return { ok: false, error: `${type}: ${e}` };
  }
  return { ok: true, msg };
}
