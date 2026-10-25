// Turns the user's prompt + keywords + theme into a list of slots to fill.
// One Claude Haiku call with a forced tool call (same pattern as the Tracker),
// with a deterministic fallback so scraping still works without the API.

import type { LibraryPlan, MusicSlot, SetupInput, SfxSlot, VoiceSlot } from "./types";

const SFX_MAX_S = 1.5; // spec: keep SFX under 1.5 s
const MAX_SFX_SLOTS = 30;
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

// The description typed before the talk is a PRIOR, not a script. No genre or topic is assumed here: the model infers tone and
// setting from the words it is given, and stays broad when they are vague (the live director narrows it down from the speech).
const GROUNDING =
  "THE DESCRIPTION IS A PRIOR, NOT A SCRIPT. Infer the setting, tone and genre only from what it actually says; do not add plot elements, a genre or a music style that none of its words support. " +
  "When it is short or vague, plan the concrete sound-making events TYPICAL of that kind of story (what people usually say happened in it) plus ambience, instead of committing to one imagined storyline: the live speech will decide the specifics. " +
  "Music moods are emotional feelings, not genres or settings.";

// HOW TO WRITE A SOUND SO IT CAN BE FOUND, MADE AND TRIGGERED — shared by every planning call (setup and live rounds).
// Rules only (the short examples show the FORMAT of a field): no theme is mapped to sounds in code, Claude decides per talk.
const SOUND_WRITING = [
  "HOW TO WRITE EACH SOUND:",
  "- queries (3, tried in order until one finds files on Freesound): 1) how sound designers tag it, 2-3 words, noun + sound verb ('tent zipper', 'campfire crackle'); 2) a different common wording ('zip opening', 'fire burning'); 3) one or two broad words that surely exist ('zipper', 'fire'). No mood adjectives, story context, names or brands.",
  "- gen_prompt (a sound generator uses it when the search fails): what is physically heard, one event, close and dry, no music, no voices, with how long or how many times ('A tent zipper pulled open in one quick motion, close').",
  "- instant (2-4): short ways people SAY it is happening, present and past and the sound word itself ('zips the tent', 'unzipped', 'zip'; 'phone rang', 'ringing'; 'bang', 'beep beep'). Never a bare object or place ('the tent', 'the office').",
  "- One distinct event per sound; no near-duplicates (one door knock, not three variations).",
].join("\n");

// LIVE DIRECTOR: during the talk each round is a decision, not a plan. The model sees the pre-talk prior, what was actually said,
// the library and what is playing, and picks the best action (often: add nothing).
const LIVE_DIRECTOR = [
  "You are the live sound director of Syncopation, an app that enhances a real, unscripted speech with music, ambience and sound effects.",
  "Before the talk a library was planned from a short description: that is only a PRIOR. Now the speaker is talking and the message gives you the evidence: what was just said, what is already in the library (and what was played), what is playing right now, and the pre-talk plan.",
  "Decide the best action from the evidence, whatever the topic or genre turns out to be:",
  "- YOUR MAIN JOB IS TO STAY ONE STEP AHEAD. Picture the scene the speaker just entered or announced (where they are, what they set out to do) and the ACTIONS that happen there that make a distinct sound and that the next sentences are likely to NAME. The library must have those BEFORE they are said: a sound fetched after the word is too late, so NEVER wait for an action to be named — 'not named yet' is exactly when to fetch it. When the speaker announces what someone set out to do, the sounds OF DOING it come next.",
  "- So in most rounds add 1-4 sounds for those likely next actions, most likely first, plus any sound-making event the words just named that the library lacks (it may come up again).",
  "- Return an EMPTY sfx array only when the speech is small talk / off-topic, or when the library already has a sound for EACH of the scene's likely next actions (a bed or a loosely related sound does not count). Never add quiet textures nobody names or near-duplicates of library sounds.",
  "- Otherwise return only the sounds that are MISSING: sounds the words name or imply, and sounds likely soon in the story AS TOLD. Weigh the prior and the speech as evidence: when they disagree, the speech wins; when the speech is ordinary, plan ordinary sounds whatever the prior suggested; when they agree, use the prior's sounds.",
  "- Add an ambience bed (id ending _ambience) only when the place changed or no existing bed fits where the speaker is.",
  "- Fill every metadata field so the sound MESHES with what is playing now: intensity, softness, emphasis, length_s, attack, tail. A sound that must sit inside the music and ambience is soft with a gentle attack and a longer tail; a hit that should cut through is sharp with an instant attack and a short tail; a pivotal moment gets high emphasis, a passing detail low.",
  SOUND_WRITING,
  "- Return at most 6 sounds, an empty music array and an empty voice array.",
  "- Put one line in `read`: what the speech is actually about, how well the library fits it, and why you added what you added.",
].join("\n");

const PLAN_TOOL = {
  name: "plan_library",
  description: "Plan the sound library for a live talk.",
  input_schema: {
    type: "object",
    properties: {
      read: { type: "string", description: "LIVE ROUNDS ONLY: one line on what the speech is actually about, how well the library fits it, and why these sounds were added (or none)" },
      sfx: {
        type: "array",
        maxItems: MAX_SFX_SLOTS,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "snake_case id, e.g. door_creak" },
            label: { type: "string" },
            queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "3 Freesound searches tried in order: specific 2-3 words as sound designers tag it, another common wording, then 1-2 broad words" },
            gen_prompt: { type: "string", description: "What is physically heard: one event, close and dry, no music or voices, how long / how many times" },
            safety: { type: "string", enum: ["speculative", "committed"], description: "speculative = risers, swells, drones, ambience that can fade out harmlessly; committed = discrete events (hits, creaks, knocks) that only make sense after their trigger word" },
            intensity: { type: "number", minimum: 0, maximum: 1, description: "how intense / energetic the sound itself is (a whisper-quiet creak 0.1, a crash 0.9)" },
            tags: { type: "array", items: { type: "string" }, maxItems: 8 },
            instant: { type: "array", items: { type: "string" }, maxItems: 4, description: "2-4 ways a speaker SAYS it is happening, present and past and the sound word ('barks', 'the dog barked', 'woof'); never a bare noun or place" },
            emphasis: { type: "number", minimum: 0, maximum: 1, description: "STORY WEIGHT of this event, not loudness: 0-0.3 incidental detail, 0.4-0.6 supporting moment, 0.7-1 a pivotal event the story turns on. The live mixer decides from the scene whether to soften or lift it." },
            softness: { type: "number", minimum: 0, maximum: 1, description: "the sound's own character: 0 = sharp, harsh transient (crash, bang, buzzer), 0.5 = ordinary, 1 = gentle and diffuse (rustle, murmur, pour, soft footsteps)" },
            length_s: { type: "number", minimum: 0.3, maximum: 4, description: "how long this sound should last in seconds: a click or knock 0.3-0.6, a door slam or ring 1-1.5, a swell, riser or rolling thunder 2-4" },
            attack: { type: "number", minimum: 0, maximum: 1, description: "how it starts: 0 = instant onset (hit, click), 0.5 = quick build, 1 = slow swell in" },
            tail: { type: "number", minimum: 0, maximum: 1, description: "how it ends: 0 = clean cut (knock, click), 0.5 = natural decay, 1 = long lingering fade (rumble, chime, wash)" },
            event: { type: "string", description: "one short line: the event this sound represents" },
          },
          required: ["id", "label", "queries", "gen_prompt", "safety", "intensity", "tags", "instant", "emphasis", "softness", "length_s", "attack", "tail", "event"],
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
    // `read` is optional: only the live director fills it
  },
} as const;

function systemPrompt(input: SetupInput, fast = 0): string {
  if (input.live) return LIVE_DIRECTOR;
  if (fast) return [
    "You plan the OPENING of a small sound library for Syncopation, which adds music and sound effects under a live speaker.",
    GROUNDING,
    `Theme: ${input.theme}. Return exactly 2 music moods that fit (lowest intensity first; the first opens the talk) and exactly ${fast} SFX slots:`,
    "plus one ambience bed (id containing 'ambience'), and as the rest the sounds the speaker is most likely to SAY OUT LOUD early in this kind of story, most likely first.",
    "TURN THE ABSTRACT THEME INTO CONCRETE EVENTS. Method: 1) picture how people actually tell this kind of story out loud; 2) list the scenes it usually passes through; 3) in each scene, the ACTIONS people do or things that happen that make a distinct sound, and that the teller would NAME with a verb; 4) keep the ones most likely said early.",
    "Pick distinct EVENTS with a clear sound, not quiet textures nobody mentions (cutlery clink, chair scrape, paper rustle) and not generic swells.",
    "Every SFX has its own planned length (length_s, usually 0.3-2 s; up to 4 s only for a swell, riser or long event) except the ambience bed. Fill intensity, softness, length_s, attack and tail for each sound: they decide how it is searched, trimmed and faded in the mix. Keep every field short.",
    SOUND_WRITING,
    "Voice layer is off: return an empty voice array.",
    "MUSIC queries are an instrumental STYLE + instrument + mood (e.g. 'upbeat indie pop guitar', 'light funk groove', 'soft lofi piano'), never the story's events.",
    "MUSIC TASTE: fun / funny / light talks get upbeat but tasteful modern music (indie pop, funk groove, light acoustic, lofi, light jazz), never cartoon, circus, kids, kazoo, slide-whistle or novelty music; serious talks get cinematic or ambient beds.",
  ].join("\n");
  return [
    "You plan a small sound library for Syncopation, which adds music and sound effects under a live speaker.",
    GROUNDING,
    "Return only what the talk needs. Every SFX is short and must sit under a voice without distracting: give each its own length_s (usually 0.3-2 s, up to 4 s only for a swell, riser or long event) and decide its intensity, softness, attack and tail yourself, from what the sound is and how the story would use it. Exception: background ambience or drone beds are long loops; give them an id containing 'ambience' or 'drone' (e.g. airport_ambience) so they are fetched as loops.",
    input.moods.length
      ? `Theme: ${input.theme}. Music moods (return exactly one music entry per mood, in this order): ${input.moods.join(", ")}.`
      : `Theme: ${input.theme}. Choose 4-6 music moods that fit this theme and the talk, ordered from lowest to highest intensity, and return exactly one music entry per mood (mood = one or two words).`,
    input.themeSfx.length ? `Theme default SFX ids (include each): ${input.themeSfx.join(", ")}.` : "",
    "Add one SFX slot per user keyword that names a sound; skip keywords that are not sounds (an object or place only counts if it implies a sound).",
    input.layers.music
      ? "Also add SFX slots for sounds this kind of talk would plausibly need that the keywords miss (aim for 24-28 total), for ANY theme (comedy, nature, business, romance, sport...). Cover many situations the story could go through, with varied, concrete sounds: actions, objects, places, vehicles, weather, reactions, crowds."
      : "This is a quick follow-up round during the talk: return at most 8 SFX slots, only for the moments described, none that are already in the library.",
    input.layers.music ? "Include 2-3 speculative slots that fit the tone you infer (ambience beds, or gentle swells, drones or risers if they suit it) that can fade out harmlessly." : "",
    SOUND_WRITING,
    "MUSIC queries are an instrumental STYLE + instrument + mood, never the story's events or places: 'upbeat acoustic guitar loop', 'tense pizzicato strings', 'soft lofi piano', 'playful ukulele', 'dark ambient pad'. A phrase like 'urgent hurry' or 'late for work' returns street recordings and alarms, not music. Everyday / lifestyle talks get light, modern music (lofi, acoustic, indie pop, light jazz).",
    "AMBIENCE beds loop for minutes: steady background only (room tone, cafe murmur, light traffic, rain), never one-off events (horns, sirens, alarms, announcements) in their queries.",
    "ORDER MATTERS: list the SFX from most to least likely to be NAMED by the speaker (concrete events with a verb: 'the doorbell rang', 'the dog barked', 'the glass shattered'), quiet textures last. List music moods from lowest to highest intensity; the first one opens the talk.",
    "MUSIC TASTE: fun / funny / light talks get upbeat but tasteful modern music (indie pop, funk groove, light acoustic, lofi, light jazz), never cartoon, circus, kids, kazoo, slide-whistle or novelty music; serious talks get cinematic or ambient beds.",
    input.layers.voice
      ? "Voice layer is on: add up to 4 very short voice lines that fit the theme."
      : "Voice layer is off: return an empty voice array.",
    input.layers.sfx ? "" : "SFX layer is off: return an empty sfx array.",
    input.layers.music ? "" : "Music layer is off: return an empty music array.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function planWithClaude(input: SetupInput, apiKey: string, model: string, fast = 0): Promise<LibraryPlan> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: fast ? 2500 : 8000,
      system: systemPrompt(input, fast),
      tools: [PLAN_TOOL],
      tool_choice: { type: "tool", name: PLAN_TOOL.name },
      messages: [
        {
          role: "user",
          content: `Talk description: ${input.prompt || "(none)"}\nKeywords: ${input.keywords.join(", ")}${input.script ? `\nScript excerpt:\n${input.script.slice(0, 3000)}` : ""
            }`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Claude plan failed: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { content: Array<{ type: string; input?: any }> };
  const call = data.content.find((c) => c.type === "tool_use");
  if (!call?.input) throw new Error("Claude plan returned no tool call");
  // live rounds never get the default speculative sounds: the director's answer (even an empty one) is final
  const plan = normalizePlan(fromToolInput(call.input), input, false, !!fast || !!input.live);
  if (input.live && typeof call.input.read === "string") plan.read = call.input.read;
  return plan;
}

/** The model occasionally returns a list as a JSON string or a single object. */
function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : p ? [p] : [];
    } catch {
      return [];
    }
  }
  return v && typeof v === "object" ? [v] : [];
}

export function fromToolInput(raw: any): LibraryPlan {
  const sfx: SfxSlot[] = asArray(raw.sfx).map((s: any) => ({
    kind: "sfx",
    id: slug(s.id ?? s.label),
    label: String(s.label ?? s.id),
    queries: (s.queries ?? []).map(String).filter(Boolean),
    genPrompt: String(s.gen_prompt ?? s.label),
    safety: s.safety === "speculative" ? "speculative" : "committed",
    intensity: clamp01(Number(s.intensity ?? 0.5)),
    maxDurationS: Number.isFinite(Number(s.length_s)) && Number(s.length_s) > 0 ? Math.min(5, Math.max(0.6, Number(s.length_s) * 1.5)) : SFX_MAX_S,
    tags: (s.tags ?? []).map(String),
    instant: Array.isArray(s.instant) ? s.instant.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean) : undefined,
    emphasis: typeof s.emphasis === "number" ? clamp01(s.emphasis) : undefined,
    softness: typeof s.softness === "number" ? clamp01(s.softness) : undefined,
    lengthS: typeof s.length_s === "number" ? Math.min(4, Math.max(0.3, s.length_s)) : undefined,
    attack: typeof s.attack === "number" ? clamp01(s.attack) : undefined,
    tail: typeof s.tail === "number" ? clamp01(s.tail) : undefined,
    event: s.event ? String(s.event) : undefined,
  }));
  const music: MusicSlot[] = asArray(raw.music).map((m: any) => ({
    kind: "music",
    id: `music_${slug(m.mood)}`,
    mood: String(m.mood),
    queries: (m.queries ?? []).map(String).filter(Boolean),
    genPrompt: String(m.gen_prompt ?? `${m.mood} instrumental underscore`),
    intensity: clamp01(Number(m.intensity ?? 0.5)),
    tags: (m.tags ?? []).map(String),
  }));
  const voice: VoiceSlot[] = asArray(raw.voice).map((v: any) => ({
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
  const moods = input.moods.length ? input.moods : ["calm", "building", "intense", "resolved"];
  input = { ...input, moods };
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
  return normalizePlan({ sfx, music, voice: [] }, input, true);
}

// ----------------------------------------------------------------- cleanup

/** Applies layer toggles, adds base speculative sounds when the plan has none, dedupes, caps sizes. */
export function normalizePlan(plan: LibraryPlan, input: SetupInput, forceBase = false, noBase = false): LibraryPlan {
  const seen = new Set<string>();
  const sfx: SfxSlot[] = [];
  if (input.layers.sfx) {
    // The AI plan chooses its own speculative sounds; the horror-flavoured defaults only back up a plan without any
    if (!noBase && (forceBase || !plan.sfx.some((s) => s.safety === "speculative"))) {
      for (const base of BASE_SPECULATIVE) {
        sfx.push({ kind: "sfx", safety: "speculative", maxDurationS: base.id === "drone" ? 20 : 4, tags: words(base.label), ...base });
        seen.add(base.id);
      }
    }
    for (const s of plan.sfx) {
      if (seen.has(s.id) || !s.queries.length) continue;
      seen.add(s.id);
      sfx.push(s);
    }
  }
  // Music covers every requested mood in order (so the tracker's mood enum resolves); with no moods given, the AI's own choice is kept.
  const moods = input.moods.length ? input.moods : plan.music.map((m) => m.mood);
  const music: MusicSlot[] = !input.layers.music
    ? []
    : moods.map((mood, i) => {
      const found = plan.music.find((m) => slug(m.mood) === slug(mood));
      return (
        found ?? {
          kind: "music",
          id: `music_${slug(mood)}`,
          mood,
          queries: [`${mood} ambient loop`],
          genPrompt: `Instrumental ${mood} underscore, sparse, no vocals, loopable`,
          intensity: moods.length > 1 ? i / (moods.length - 1) : 0.5,
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
