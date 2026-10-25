// monitor.ts — THE FAST LANE FOR SOUNDS THE LIBRARY DOESN'T HAVE.
//
// Watches the words while they stream in. When they name a sound-making EVENT that no library sound covers, one small
// Claude call writes that sound (search words + the same metadata the planner writes: length, softness, attack, tail,
// emphasis), one Freesound search fetches it (ElevenLabs makes it when nothing is found), and it's handed back with the
// moment it was said, so predict.ts can play it if it's still in time, fade it in late if it's a soft lasting sound, and
// keep it for the next mention either way.
//
// It runs NEXT TO the other loops and never blocks them:
//   · fast loop (predict.ts, ~20 ms)  plays what's in the library
//   · this monitor (~2-3 s per sound) adds what was just named and isn't
//   · slow loop (Claude, every sentence) predicts 5 steps ahead and bets on sounds before they're said
//   · director rounds (every ~4 s) fill out the scene

import { fromToolInput } from "./convex/lib/planner";
import type { SfxSlot, SoundRecord } from "./convex/lib/types";
import { fetchSlots } from "./scripts/buildLibrary";

export type Found = { rec: SoundRecord & { url: string }; word: string; heardAt: number; askedMs: number; totalMs: number };

const MIN_GAP_MS = 700;       // at most ~1.5 checks a second while talking
const MIN_NEW_WORDS = 3;      // a check needs a few new words to look at
const MAX_IN_FLIGHT = 2;      // two checks can overlap (a long sentence keeps naming things)

const TOOL = {
  name: "missing_sounds",
  description: "Sound-making events in the words that no library sound covers",
  input_schema: {
    type: "object", required: ["sfx"],
    properties: {
      sfx: {
        type: "array", maxItems: 2,
        items: {
          type: "object",
          required: ["word", "id", "label", "queries", "gen_prompt", "instant", "length_s", "softness", "attack", "tail", "emphasis", "intensity"],
          properties: {
            word: { type: "string", description: "the exact word(s) from the text that name it" },
            id: { type: "string", description: "snake_case, e.g. wolf_howl" },
            label: { type: "string" },
            queries: { type: "array", maxItems: 3, items: { type: "string" }, description: "Freesound searches, specific (2-3 words as sound designers tag it) to broad (1-2 words)" },
            gen_prompt: { type: "string", description: "what is physically heard: one event, close and dry, no music or voices" },
            instant: { type: "array", maxItems: 4, items: { type: "string" }, description: "ways a speaker says it is happening, present and past and the sound word" },
            length_s: { type: "number" }, softness: { type: "number" }, attack: { type: "number" }, tail: { type: "number" },
            emphasis: { type: "number" }, intensity: { type: "number" },
          },
        },
      },
    },
  },
} as const;

const SYSTEM = [
  "You watch a live speech for a sound designer. The text is what the speaker is saying right now (it may end mid-sentence).",
  "Return the sound-making EVENTS that are HAPPENING in the story in these words (or clearly about to, as the sentence ends) and that NO library sound covers.",
  "Strict: an event, not a mention ('the dog barked' yes; 'I love dogs' no); skip anything a library sound already covers, even loosely; usually return [].",
  "Fill the metadata so it meshes with music under a voice: length_s 0.3-4, softness 0 sharp..1 gentle, attack 0 instant..1 slow swell, tail 0 clean cut..1 long fade, emphasis = story weight 0..1, intensity 0..1.",
  "Keep every field short.",
].join("\n");

export function createMonitor(o: {
  dir: string;
  library: () => string[];                        // ids (with short descriptions) of what's already there
  onFound: (f: Found) => void | Promise<void>;
  log: (msg: string) => void;
}) {
  const asked = new Set<string>();                // ids and words already requested this talk: never twice
  let lastAt = 0, lastWords = 0, inFlight = 0, utterance = "";

  async function check(text: string, heardAt: number) {
    inFlight++;
    const t0 = Date.now();
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: process.env.CLAUDE_MODEL || "claude-haiku-5-5", max_tokens: 700,
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          tools: [TOOL], tool_choice: { type: "tool", name: TOOL.name },
          messages: [{ role: "user", content: `Library: ${o.library().join("; ")}\nAlready requested: ${[...asked].join(", ") || "none"}\nWords: "${text}"` }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const data: any = await res.json();
      const raw = data.content?.find((c: any) => c.type === "tool_use")?.input;
      const items: any[] = Array.isArray(raw?.sfx) ? raw.sfx : [];
      const have = new Set(o.library().map(s => s.split(" ")[0]));
      const fresh = items.filter(s => s?.id && !asked.has(s.id) && !have.has(s.id) && !asked.has(String(s.word ?? "").toLowerCase()));
      if (!fresh.length) return;
      const askedMs = Date.now() - t0;
      const slots: SfxSlot[] = fromToolInput({ sfx: fresh }).sfx;
      for (const s of fresh) { asked.add(s.id); if (s.word) asked.add(String(s.word).toLowerCase()); }
      o.log(`"${fresh.map(s => s.word).join('", "')}" isn't in the library → fetching ${slots.map(s => s.id).join(", ")} (asked in ${askedMs} ms)`);
      const wordOf = new Map(slots.map((sl, i) => [sl.id, String(fresh[i]?.word ?? "")])); // same order as `fresh`
      await fetchSlots(slots, o.dir, rec => o.onFound({ rec, word: wordOf.get(rec.slotId) ?? "", heardAt, askedMs, totalMs: Date.now() - heardAt }));
    } catch { /* a slow or failed check just means this one is missed; the director rounds still cover it */ }
    finally { inFlight--; }
  }

  return {
    /** Every partial and final transcript goes here; cheap when nothing needs checking. */
    watch(text: string, final = false) {
      const words = text.trim().split(/\s+/).filter(Boolean);
      // a new utterance (the recogniser started over) resets the word count
      if (!text.startsWith(utterance.slice(0, Math.min(utterance.length, 12)))) lastWords = 0;
      utterance = text;
      const now = Date.now();
      if (inFlight >= MAX_IN_FLIGHT || now - lastAt < MIN_GAP_MS) return;
      if (!final && words.length - lastWords < MIN_NEW_WORDS) return;
      lastAt = now; lastWords = final ? 0 : words.length;
      void check(words.slice(-25).join(" "), now);
    },
  };
}
