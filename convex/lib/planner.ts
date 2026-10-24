// Turns the user's prompt + keywords + theme into a list of slots to fill.
// One Claude Haiku call with a forced tool call (same pattern as the Tracker),
// with a deterministic fallback so scraping still works without the API.

import type { LibraryPlan, MusicSlot, SetupInput, SfxSlot, VoiceSlot } from "./types";

const SFX_MAX_S = 1.5; // spec: keep SFX under 1.5 s
const MAX_SFX_SLOTS = 12;
const MAX_VOICE_SLOTS = 4;

/** Speculative sounds every library gets (spec: "Prevent" table). */
const BASE_SPECULATIVE: Array<Pick<SfxSlot, "id" | "label" | "queries" | "genPrompt" | "intensity">> = [
  { id: "riser", label: "Riser", queries: ["riser", "tension riser", "cinematic riser"], genPrompt: "Short cinematic tension riser, building, no impact at the end", intensity: 0.7 },
  { id: "swell", label: "Swell", queries: ["swell", "reverse swell", "cinematic swell"], genPrompt: "Soft reverse cymbal swell, smooth fade in", intensity: 0.5 },
  { id: "drone", label: "Drone", queries: ["dark drone", "ambient drone loop"], genPrompt: "Low dark ambient drone, steady, seamless loop", intensity: 0.3 },
];

export const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "sound";

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

// ---------------------------------------------------------------- Claude call

const PLAN_TOOL = {
  name: "plan_library",
  description: "Plan the sound library for a live talk.",
  input_schema: {
    type: "object",
    properties: {
      sfx: {
        type: "array",
        maxItems: MAX_SFX_SLOTS,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "snake_case id, e.g. door_creak" },
            label: { type: "string" },
            queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "2–4 word sound-library search phrases, best first" },
            gen_prompt: { type: "string", description: "One-sentence prompt for a text-to-SFX model" },
            safety: { type: "string", enum: ["speculative", "committed"], description: "speculative = risers, swells, drones, ambience that can fade out harmlessly; committed = discrete events (hits, creaks, knocks) that only make sense after their trigger word" },
            intensity: { type: "number", minimum: 0, maximum: 1 },
            tags: { type: "array", items: { type: "string" }, maxItems: 8 },
          },
          required: ["id", "label", "queries", "gen_prompt", "safety", "intensity", "tags"],
        },
      },
      music: {
        type: "array",
        items: {
          type: "object",
          properties: {
            mood: { type: "string" },
            queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
            gen_prompt: { type: "string", description: "Instrumental underscore prompt, no vocals" },
            intensity: { type: "number", minimum: 0, maximum: 1 },
            tags: { type: "array", items: { type: "string" }, maxItems: 8 },
          },
          required: ["mood", "queries", "gen_prompt", "intensity", "tags"],
        },
      },
      voice: {
        type: "array",
        maxItems: MAX_VOICE_SLOTS,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            line: { type: "string", description: "Very short line (1–5 words) a voice says" },
            emotion: { type: "string" },
            tags: { type: "array", items: { type: "string" }, maxItems: 6 },
          },
          required: ["id", "line", "tags"],
        },
      },
    },
    required: ["sfx", "music", "voice"],
  },
} as const;

function systemPrompt(input: SetupInput): string {
  return [
    "You plan a small sound library for Syncopation, which adds music and sound effects under a live speaker.",
    "Return only what the talk needs. Every SFX must be short (under 1.5 s) and must sit under a voice without distracting.",
    `Theme: ${input.theme}. Music moods (return exactly one music entry per mood, in this order): ${input.moods.join(", ")}.`,
    `Theme default SFX ids (include each): ${input.themeSfx.join(", ") || "none"}.`,
    "Add one SFX slot per user keyword that names a sound; skip keywords that are not sounds (e.g. 'ghost' → whisper or eerie breath; 'house' → skip unless it implies a sound).",
    "Queries are for Freesound text search: concrete nouns + verbs, no adjectives like 'scary'.",
    input.layers.voice
      ? "Voice layer is on: add up to 4 very short voice lines that fit the theme."
      : "Voice layer is off: return an empty voice array.",
    input.layers.sfx ? "" : "SFX layer is off: return an empty sfx array.",
    input.layers.music ? "" : "Music layer is off: return an empty music array.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function planWithClaude(input: SetupInput, apiKey: string, model: string): Promise<LibraryPlan> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: systemPrompt(input),
      tools: [PLAN_TOOL],
      tool_choice: { type: "tool", name: PLAN_TOOL.name },
      messages: [
        {
          role: "user",
          content: `Talk description: ${input.prompt || "(none)"}\nKeywords: ${input.keywords.join(", ")}${
            input.script ? `\nScript excerpt:\n${input.script.slice(0, 3000)}` : ""
          }`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Claude plan failed: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { content: Array<{ type: string; input?: any }> };
  const call = data.content.find((c) => c.type === "tool_use");
  if (!call?.input) throw new Error("Claude plan returned no tool call");
  return normalizePlan(fromToolInput(call.input), input);
}

function fromToolInput(raw: any): LibraryPlan {
  const sfx: SfxSlot[] = (raw.sfx ?? []).map((s: any) => ({
    kind: "sfx",
    id: slug(s.id ?? s.label),
    label: String(s.label ?? s.id),
    queries: (s.queries ?? []).map(String).filter(Boolean),
    genPrompt: String(s.gen_prompt ?? s.label),
    safety: s.safety === "speculative" ? "speculative" : "committed",
    intensity: clamp01(Number(s.intensity ?? 0.5)),
    maxDurationS: SFX_MAX_S,
    tags: (s.tags ?? []).map(String),
  }));
  const music: MusicSlot[] = (raw.music ?? []).map((m: any) => ({
    kind: "music",
    id: `music_${slug(m.mood)}`,
    mood: String(m.mood),
    queries: (m.queries ?? []).map(String).filter(Boolean),
    genPrompt: String(m.gen_prompt ?? `${m.mood} instrumental underscore`),
    intensity: clamp01(Number(m.intensity ?? 0.5)),
    tags: (m.tags ?? []).map(String),
  }));
  const voice: VoiceSlot[] = (raw.voice ?? []).map((v: any) => ({
    kind: "voice",
    id: `voice_${slug(v.id ?? v.line)}`,
    line: String(v.line),
    emotion: v.emotion ? String(v.emotion) : undefined,
    tags: (v.tags ?? []).map(String),
  }));
  return { sfx, music, voice };
}

// ------------------------------------------------------------ fallback plan

/** Deterministic plan used when Claude is unavailable. Good enough for a demo. */
export function fallbackPlan(input: SetupInput): LibraryPlan {
  const ids = [...input.themeSfx, ...input.keywords.map(slug)];
  const sfx: SfxSlot[] = ids.map((id) => {
    const phrase = id.replace(/_/g, " ");
    return {
      kind: "sfx",
      id,
      label: phrase,
      queries: [phrase],
      genPrompt: `Short ${phrase} sound effect, close and clean, no music`,
      safety: "committed",
      intensity: 0.6,
      maxDurationS: SFX_MAX_S,
      tags: words(phrase),
    };
  });
  const music: MusicSlot[] = input.moods.map((mood, i) => ({
    kind: "music",
    id: `music_${slug(mood)}`,
    mood,
    queries: [`${mood} ambient loop`, `${mood} underscore`],
    genPrompt: `Instrumental ${mood} underscore for a ${input.theme.replace(/_/g, " ")}, sparse, no vocals, loopable`,
    intensity: input.moods.length > 1 ? i / (input.moods.length - 1) : 0.5,
    tags: [mood, "ambient", "loop"],
  }));
  return normalizePlan({ sfx, music, voice: [] }, input);
}

// ----------------------------------------------------------------- cleanup

/** Applies layer toggles, adds the base speculative sounds, dedupes, caps sizes. */
export function normalizePlan(plan: LibraryPlan, input: SetupInput): LibraryPlan {
  const seen = new Set<string>();
  const sfx: SfxSlot[] = [];
  if (input.layers.sfx) {
    for (const base of BASE_SPECULATIVE) {
      sfx.push({ kind: "sfx", safety: "speculative", maxDurationS: base.id === "drone" ? 20 : 4, tags: words(base.label), ...base });
      seen.add(base.id);
    }
    for (const s of plan.sfx) {
      if (seen.has(s.id) || !s.queries.length) continue;
      seen.add(s.id);
      sfx.push(s);
    }
  }
  // Music must cover every theme mood, in theme order, so the tracker's mood enum always resolves.
  const music: MusicSlot[] = !input.layers.music
    ? []
    : input.moods.map((mood, i) => {
        const found = plan.music.find((m) => slug(m.mood) === slug(mood));
        return (
          found ?? {
            kind: "music",
            id: `music_${slug(mood)}`,
            mood,
            queries: [`${mood} ambient loop`],
            genPrompt: `Instrumental ${mood} underscore, sparse, no vocals, loopable`,
            intensity: input.moods.length > 1 ? i / (input.moods.length - 1) : 0.5,
            tags: [mood],
          }
        );
      });
  const voice = input.layers.voice ? dedupe(plan.voice).slice(0, MAX_VOICE_SLOTS) : [];
  return { sfx: sfx.slice(0, MAX_SFX_SLOTS + BASE_SPECULATIVE.length), music, voice };
}

function dedupe<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5);
