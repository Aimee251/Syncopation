import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const layerV = v.union(v.literal("sfx"), v.literal("music"), v.literal("voice"));
export const densityV = v.union(v.literal("subtle"), v.literal("normal"), v.literal("expressive"));

/** Fields of one stored sound (mirrors SoundRecord in convex/lib/types.ts). */
export const soundFields = {
  sessionId: v.id("sessions"),
  id: v.string(), // "door_creak#0"
  slotId: v.string(), // "door_creak": the value in the tracker's enum
  variant: v.number(),
  layer: layerV,
  label: v.string(),
  tags: v.array(v.string()),
  intensity: v.number(),
  mood: v.optional(v.string()),
  safety: v.union(v.literal("speculative"), v.literal("committed")),
  durationMs: v.number(),
  loop: v.boolean(),
  source: v.union(v.literal("freesound"), v.literal("apify"), v.literal("elevenlabs"), v.literal("cartesia")),
  sourceId: v.string(),
  license: v.string(),
  attribution: v.optional(v.string()),
  pageUrl: v.optional(v.string()),
  storageId: v.id("_storage"),
};

export default defineSchema({
  sessions: defineTable({
    code: v.string(), // 4-digit pairing code
    prompt: v.string(),
    keywords: v.array(v.string()),
    theme: v.string(),
    moods: v.array(v.string()),
    themeSfx: v.array(v.string()),
    layers: v.object({ music: v.boolean(), sfx: v.boolean(), voice: v.boolean() }),
    density: densityV,
    script: v.optional(v.string()),
    // Filled by the scrape: the enums the tracker's tool schema is built from.
    sfxIds: v.optional(v.array(v.string())),
    voiceIds: v.optional(v.array(v.string())),
    storyState: v.optional(v.any()),
    phraseCount: v.number(),
    createdAt: v.number(),
  }).index("by_code", ["code"]),

  scrapeJobs: defineTable({
    sessionId: v.id("sessions"),
    status: v.union(v.literal("queued"), v.literal("planning"), v.literal("searching"), v.literal("done"), v.literal("failed")),
    completed: v.number(),
    total: v.number(),
    message: v.string(),
    providers: v.array(v.string()),
    missing: v.array(v.string()),
    log: v.array(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_session", ["sessionId"]),

  sounds: defineTable(soundFields).index("by_session", ["sessionId"]).index("by_session_slot", ["sessionId", "slotId"]),

  // ---- Tables owned by later steps (tracker / learning); kept loose until those land.
  phrases: defineTable({ sessionId: v.id("sessions"), index: v.number(), text: v.string() }).index("by_session", ["sessionId", "index"]),
  predictions: defineTable({ sessionId: v.id("sessions"), atPhrase: v.number(), seq: v.number(), storyState: v.any(), slots: v.any() }).index("by_session", ["sessionId", "atPhrase"]),
  cues: defineTable({ sessionId: v.id("sessions"), soundId: v.optional(v.string()), phrase: v.number(), features: v.array(v.number()), action: v.string(), reward: v.optional(v.number()) }).index("by_session", ["sessionId"]),
  models: defineTable({ theme: v.string(), A: v.any(), b: v.any(), tau: v.number(), soundStats: v.any() }).index("by_theme", ["theme"]),
});
