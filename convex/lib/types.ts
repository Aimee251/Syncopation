// Shared types for the Scrape service. Pure TypeScript: no Convex imports,
// so the same code runs inside a Convex action and in scripts/buildLibrary.ts.

export type Layer = "sfx" | "music" | "voice";
export type Density = "subtle" | "normal" | "expressive";

/** Speculative sounds may fire on a prediction alone; committed ones only after a trigger word. */
export type Safety = "speculative" | "committed";

export type SourceName = "freesound" | "apify" | "elevenlabs" | "cartesia";

/** What the user set on the Setup screen (spec: User flow, steps 1–5). */
export interface SetupInput {
  prompt: string; // free-text talk description
  keywords: string[]; // "abandoned house", "storm", ...
  theme: string; // "spooky_story"
  moods: string[]; // from the theme
  themeSfx: string[]; // theme's default sfx ids, e.g. ["door_creak", "hit"]
  layers: { music: boolean; sfx: boolean; voice: boolean };
  density: Density;
  script?: string;
}

/** One thing the library must contain. A slot becomes 1–2 stored sounds (variants). */
export interface SfxSlot {
  kind: "sfx";
  id: string; // enum value the tracker will use, e.g. "door_creak"
  label: string;
  queries: string[]; // search phrases, best first
  genPrompt: string; // ElevenLabs prompt if search fails
  safety: Safety;
  intensity: number; // 0–1, used by the tension-fit feature
  maxDurationS: number;
  tags: string[];
}

export interface MusicSlot {
  kind: "music";
  id: string; // "music_uneasy"
  mood: string; // "uneasy"
  queries: string[];
  genPrompt: string;
  intensity: number;
  tags: string[];
}

export interface VoiceSlot {
  kind: "voice";
  id: string; // "voice_whisper_get_out"
  line: string; // what the voice says
  emotion?: string; // Cartesia emotion hint
  tags: string[];
}

export type Slot = SfxSlot | MusicSlot | VoiceSlot;

export interface LibraryPlan {
  sfx: SfxSlot[];
  music: MusicSlot[];
  voice: VoiceSlot[];
}

/** A sound found by a search provider, before download. */
export interface Candidate {
  source: SourceName;
  sourceId: string;
  name: string;
  tags: string[];
  durationS: number;
  audioUrl: string;
  license: string;
  attribution?: string; // "name by user (license)" when the license requires credit
  pageUrl?: string;
  rating?: number; // 0–5
  downloads?: number;
}

/** A sound whose bytes are in hand (downloaded or generated). */
export interface ResolvedSound {
  slot: Slot;
  variant: number; // 0 = main, 1 = alternate (used by the "softer variant" action and repeat penalty)
  candidate: Candidate;
  bytes: ArrayBuffer;
  contentType: string;
}

/** The row stored per sound; matches the spec's `sounds` table plus provenance fields. */
export interface SoundRecord {
  id: string; // "door_creak#0"
  slotId: string; // "door_creak" (what the model's enum refers to)
  variant: number;
  layer: Layer;
  label: string;
  tags: string[];
  intensity: number;
  mood?: string;
  safety: Safety;
  durationMs: number;
  loop: boolean;
  source: SourceName;
  sourceId: string;
  license: string;
  attribution?: string;
  pageUrl?: string;
}

export interface ProgressEvent {
  stage: "planning" | "searching" | "done";
  completed: number;
  total: number;
  message: string;
}
