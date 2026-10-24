import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * The library in the same shape as public/library.json, so the output phone's
 * loader only swaps its data source:
 *   const lib = await convex.query(api.library.forSession, { sessionId })
 * Each sound has a signed `url` to preload into Tone.js.
 */
export const forSession = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;
    const rows = await ctx.db.query("sounds").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).collect();
    const sounds = await Promise.all(
      rows.map(async ({ _id, _creationTime, sessionId: _s, storageId, ...rest }) => ({
        ...rest,
        url: await ctx.storage.getUrl(storageId),
      })),
    );
    return {
      theme: session.theme,
      moods: session.moods,
      density: session.density,
      layers: session.layers,
      sfxIds: session.sfxIds ?? [],
      voiceIds: session.voiceIds ?? [],
      sounds: sounds.sort((a, b) => a.id.localeCompare(b.id)),
      credits: sounds.filter((s) => s.attribution).map((s) => s.attribution as string),
    };
  },
});
