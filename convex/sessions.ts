import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { densityV } from "./schema";

/** Setup.tsx → creates the session and kicks off the Scrape job in the background. */
export const create = mutation({
  args: {
    prompt: v.string(),
    keywords: v.array(v.string()),
    theme: v.string(),
    moods: v.array(v.string()),
    themeSfx: v.array(v.string()),
    layers: v.object({ music: v.boolean(), sfx: v.boolean(), voice: v.boolean() }),
    density: densityV,
    script: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const keywords = Array.from(new Set(args.keywords.map((k) => k.trim()).filter(Boolean))).slice(0, 15);
    if (!keywords.length) throw new Error("Add at least one keyword");
    if (!args.moods.length) throw new Error("Theme has no moods");
    if (!args.layers.music && !args.layers.sfx && !args.layers.voice) throw new Error("Turn on at least one layer");

    const code = await uniqueCode(ctx);
    const sessionId = await ctx.db.insert("sessions", {
      ...args,
      keywords,
      code,
      phraseCount: 0,
      createdAt: Date.now(),
    });
    await ctx.db.insert("scrapeJobs", {
      sessionId,
      status: "queued",
      completed: 0,
      total: 0,
      message: "Queued",
      providers: [],
      missing: [],
      log: [],
      startedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.scrape.run, { sessionId });
    return { sessionId, code };
  },
});

export const get = query({
  args: { sessionId: v.id("sessions") },
  handler: (ctx, { sessionId }) => ctx.db.get(sessionId),
});

export const byCode = query({
  args: { code: v.string() },
  handler: (ctx, { code }) =>
    ctx.db
      .query("sessions")
      .withIndex("by_code", (q) => q.eq("code", code))
      .order("desc")
      .first(),
});

async function uniqueCode(ctx: { db: any }): Promise<string> {
  const recent = Date.now() - 12 * 60 * 60 * 1000; // codes only need to be unique among today's sessions
  for (let i = 0; i < 20; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const clash = await ctx.db
      .query("sessions")
      .withIndex("by_code", (q: any) => q.eq("code", code))
      .filter((q: any) => q.gt(q.field("createdAt"), recent))
      .first();
    if (!clash) return code;
  }
  throw new Error("Could not allocate a pairing code");
}
