// Theme presets for the Setup screen. The theme sets the music moods and default SFX;
// the user's keywords decide which specific SFX the scrape looks for.

export interface ThemePreset {
  id: string;
  label: string;
  moods: string[]; // low → high intensity
  sfx: string[];
  keywordHint: string;
}

export const THEMES: ThemePreset[] = [
  {
    id: "spooky_story",
    label: "Spooky story",
    moods: ["calm", "uneasy", "tense", "terror"],
    sfx: ["door_creak", "footsteps", "whisper", "hit"],
    keywordHint: "abandoned house, storm, footsteps, ghost",
  },
  {
    id: "thriller",
    label: "Thriller",
    moods: ["calm", "suspense", "chase", "climax"],
    sfx: ["heartbeat", "footsteps", "door_slam", "glass_break"],
    keywordHint: "chase, heartbeat, footsteps, gunshot, alarm",
  },
  {
    id: "pitch_presentation",
    label: "Pitch presentation",
    moods: ["focused", "building", "uplifting", "triumphant"],
    sfx: ["whoosh", "ding", "applause"],
    keywordHint: "launch, growth, problem, customers",
  },
  {
    id: "comedy_set",
    label: "Comedy set",
    moods: ["light", "bouncy", "awkward", "chaotic"],
    sfx: ["rimshot", "record_scratch", "boing", "crickets"],
    keywordHint: "airport, mom, dating app, cat",
  },
];
