// Cartesia: pre-renders the voice layer's short lines ("get out", a whisper)
// with Sonic TTS during the scrape, so at talk time they are just more
// preloaded sounds and never touch the network.
//
// Cartesia has no sound-effect or music generation, so it is not a source for
// the SFX/music slots; see README_SCRAPE.md for where else it fits.
//
// ⚠️ Verify against https://docs.cartesia.ai/api-reference/tts/bytes before
// shipping: header names, the API version string and the voice id are the
// parts most likely to drift.

import type { GeneratedAudio } from "./elevenlabs";

export interface CartesiaOpts {
  voiceId: string; // pick one at play.cartesia.ai (e.g. a breathy/whisper voice for spooky themes)
  model?: string; // "sonic-3"
  version?: string; // Cartesia-Version header
  emotion?: string;
}

export async function cartesiaTts(text: string, opts: CartesiaOpts, apiKey: string): Promise<GeneratedAudio> {
  const res = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "Cartesia-Version": opts.version ?? "2025-04-16",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model_id: opts.model ?? "sonic-3",
      transcript: text,
      voice: { mode: "id", id: opts.voiceId },
      language: "en",
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
      ...(opts.emotion ? { generation_config: { emotion: opts.emotion } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Cartesia TTS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { bytes: await res.arrayBuffer(), contentType: "audio/mpeg", durationS: 0 };
}
