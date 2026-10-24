// ElevenLabs: generation fallback when search finds nothing usable.
//  - SFX:   POST /v1/sound-generation  (text → short sound, optional loop)
//  - Music: POST /v1/music             (prompt → instrumental bed)
// Both return MP3 bytes directly.

const BASE = "https://api.elevenlabs.io/v1";

export interface GeneratedAudio {
  bytes: ArrayBuffer;
  contentType: string;
  durationS: number;
}

export async function generateSfx(
  prompt: string,
  opts: { durationS?: number; loop?: boolean; promptInfluence?: number },
  apiKey: string,
): Promise<GeneratedAudio> {
  // duration must be 0.5–22 s; omit it to let the model choose (cheaper per call).
  const duration = opts.durationS ? Math.min(22, Math.max(0.5, opts.durationS)) : undefined;
  const res = await fetch(`${BASE}/sound-generation?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text: prompt,
      model_id: "eleven_text_to_sound_v2",
      duration_seconds: duration,
      prompt_influence: opts.promptInfluence ?? 0.6,
      loop: opts.loop ?? false,
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs SFX HTTP ${res.status}: ${await safeText(res)}`);
  return { bytes: await res.arrayBuffer(), contentType: "audio/mpeg", durationS: duration ?? 0 };
}

export async function generateMusic(prompt: string, lengthS: number, apiKey: string): Promise<GeneratedAudio> {
  const ms = Math.round(Math.min(600, Math.max(3, lengthS)) * 1000); // API range 3 s – 10 min
  const res = await fetch(`${BASE}/music?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ prompt, music_length_ms: ms, force_instrumental: true }),
  });
  if (!res.ok) throw new Error(`ElevenLabs music HTTP ${res.status}: ${await safeText(res)}`);
  return { bytes: await res.arrayBuffer(), contentType: "audio/mpeg", durationS: ms / 1000 };
}

async function safeText(res: Response) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
