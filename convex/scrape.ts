// SCRAPE SERVICE (spec: Backend services → Scrape)
// prompt + keywords → planned slots → Freesound / Apify search → ElevenLabs / Cartesia
// fallback → files in Convex storage + rows in `sounds`.
//
// Env vars (npx convex env set NAME value):
//   ANTHROPIC_API_KEY   planner (optional; deterministic fallback without it)
//   CLAUDE_MODEL        default "claude-haiku-5-5"
//   FREESOUND_API_KEY   primary search
//   APIFY_TOKEN         secondary search (APIFY_ACTOR, APIFY_INPUT_TEMPLATE optional)
//   ELEVENLABS_API_KEY  generation fallback (ELEVENLABS_MUSIC=off to skip the music endpoint)
//   CARTESIA_API_KEY + CARTESIA_VOICE_ID   voice-layer lines

import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { soundFields } from "./schema";
import { fallbackPlan, planWithClaude } from "./lib/planner";
import { DEFAULT_OPTS, runPipeline } from "./lib/pipeline";
import { providersFromEnv } from "./lib/providersFromEnv";
import type { LibraryPlan, SetupInput } from "./lib/types";

const MAX_LOG = 60;

export const run = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.runQuery(internal.scrape.getSession, { sessionId });
    if (!session) throw new Error("session not found");

    const { providers, enabled } = providersFromEnv(process.env);
    const canFind = providers.freesound || providers.apify || providers.genSfx;
    if (!canFind) {
      await ctx.runMutation(internal.scrape.progress, {
        sessionId,
        status: "failed",
        message: "No sound source configured. Set FREESOUND_API_KEY (or APIFY_TOKEN / ELEVENLABS_API_KEY).",
      });
      return;
    }

    // 1) Plan
    await ctx.runMutation(internal.scrape.progress, { sessionId, status: "planning", message: "Planning the library", providers: enabled });
    const input: SetupInput = {
      prompt: session.prompt,
      keywords: session.keywords,
      theme: session.theme,
      moods: session.moods,
      themeSfx: session.themeSfx,
      layers: session.layers,
      density: session.density,
      script: session.script,
    };
    let plan: LibraryPlan;
    const logs: string[] = [];
    try {
      plan = process.env.ANTHROPIC_API_KEY
        ? await planWithClaude(input, process.env.ANTHROPIC_API_KEY, process.env.CLAUDE_MODEL || "claude-haiku-5-5")
        : fallbackPlan(input);
    } catch (err) {
      logs.push(`planner fell back: ${String(err).slice(0, 200)}`);
      plan = fallbackPlan(input);
    }

    // 2) Re-runs replace the old library
    await ctx.runMutation(internal.scrape.clearSounds, { sessionId });

    // 3) Search, download, store
    const result = await runPipeline(
      plan,
      providers,
      {
        save: async (sound, record) => {
          const storageId = await ctx.storage.store(new Blob([sound.bytes], { type: sound.contentType }));
          await ctx.runMutation(internal.scrape.addSound, { ...stripUndefined(record), sessionId, storageId });
        },
      },
      (e) =>
        ctx.runMutation(internal.scrape.progress, {
          sessionId,
          status: e.stage === "done" ? "searching" : e.stage, // "done" is written below with the summary
          completed: e.completed,
          total: e.total,
          message: e.message,
        }),
      DEFAULT_OPTS,
    );

    // 4) Publish the enums the tracker builds its tool schema from (only what actually exists)
    const has = new Set(result.saved.map((s) => s.slotId));
    await ctx.runMutation(internal.scrape.finish, {
      sessionId,
      sfxIds: plan.sfx.map((s) => s.id).filter((id) => has.has(id)),
      voiceIds: plan.voice.map((s) => s.id).filter((id) => has.has(id)),
      missing: result.missing,
      log: [...logs, ...result.log].slice(-MAX_LOG),
      message: result.missing.length
        ? `Library ready (${result.saved.length} sounds; nothing for ${result.missing.join(", ")})`
        : `Library ready (${result.saved.length} sounds)`,
    });
  },
});

/** Setup screen "Retry" button. */
export const rerun = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const job = await ctx.db.query("scrapeJobs").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).first();
    if (job && (job.status === "planning" || job.status === "searching")) throw new Error("Already running");
    if (job) await ctx.db.patch(job._id, { status: "queued", completed: 0, total: 0, message: "Queued", missing: [], log: [], startedAt: Date.now(), finishedAt: undefined });
    await ctx.scheduler.runAfter(0, internal.scrape.run, { sessionId });
  },
});

/** Live progress for the Setup screen. */
export const status = query({
  args: { sessionId: v.id("sessions") },
  handler: (ctx, { sessionId }) =>
    ctx.db.query("scrapeJobs").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).first(),
});

// ------------------------------------------------------------- internals

export const getSession = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: (ctx, { sessionId }) => ctx.db.get(sessionId),
});

export const progress = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    status: v.union(v.literal("planning"), v.literal("searching"), v.literal("failed")),
    message: v.string(),
    completed: v.optional(v.number()),
    total: v.optional(v.number()),
    providers: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { sessionId, ...patch }) => {
    const job = await ctx.db.query("scrapeJobs").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).first();
    if (!job) return;
    await ctx.db.patch(job._id, {
      ...stripUndefined(patch),
      ...(patch.status === "failed" ? { finishedAt: Date.now() } : {}),
    });
  },
});

export const addSound = internalMutation({
  args: soundFields,
  handler: (ctx, args) => ctx.db.insert("sounds", args),
});

export const clearSounds = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const old = await ctx.db.query("sounds").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect();
    for (const s of old) {
      await ctx.storage.delete(s.storageId);
      await ctx.db.delete(s._id);
    }
  },
});

export const finish = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    sfxIds: v.array(v.string()),
    voiceIds: v.array(v.string()),
    missing: v.array(v.string()),
    log: v.array(v.string()),
    message: v.string(),
  },
  handler: async (ctx, { sessionId, sfxIds, voiceIds, missing, log, message }) => {
    await ctx.db.patch(sessionId, { sfxIds, voiceIds });
    const job = await ctx.db.query("scrapeJobs").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).first();
    if (job) await ctx.db.patch(job._id, { status: "done", missing, log, message, finishedAt: Date.now() });
  },
});

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T;
}
