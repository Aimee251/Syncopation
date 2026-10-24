// Builds the provider set from whichever API keys are configured.
// Missing key → that provider is skipped, so you can start with Freesound only.

import type { Providers } from "./pipeline";
import { searchFreesound } from "./providers/freesound";
import { searchApify } from "./providers/apify";
import { generateMusic, generateSfx } from "./providers/elevenlabs";
import { cartesiaTts } from "./providers/cartesia";

export interface ScrapeEnv {
  FREESOUND_API_KEY?: string;
  APIFY_TOKEN?: string;
  APIFY_ACTOR?: string;
  APIFY_INPUT_TEMPLATE?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_MUSIC?: string; // "off" → use looped SFX generation for music beds instead (cheaper)
  CARTESIA_API_KEY?: string;
  CARTESIA_VOICE_ID?: string;
  CARTESIA_MODEL?: string;
  CARTESIA_VERSION?: string;
}

export function providersFromEnv(env: ScrapeEnv): { providers: Providers; enabled: string[] } {
  const enabled: string[] = [];
  const p: Providers = { download: downloadAudio };

  if (env.FREESOUND_API_KEY) {
    const key = env.FREESOUND_API_KEY;
    p.freesound = (q, o) => searchFreesound(q, o, key);
    enabled.push("freesound");
  }
  if (env.APIFY_TOKEN) {
    const token = env.APIFY_TOKEN;
    const actor = env.APIFY_ACTOR || "crawlerbros/mixkit-stock-media-scraper";
    p.apify = (q, layer) => searchApify(q, { actor, layer, inputTemplate: env.APIFY_INPUT_TEMPLATE }, token);
    enabled.push(`apify(${actor})`);
  }
  if (env.ELEVENLABS_API_KEY) {
    const key = env.ELEVENLABS_API_KEY;
    p.genSfx = (prompt, o) => generateSfx(prompt, o, key);
    if (env.ELEVENLABS_MUSIC !== "off") p.genMusic = (prompt, len) => generateMusic(prompt, len, key);
    enabled.push("elevenlabs");
  }
  if (env.CARTESIA_API_KEY && env.CARTESIA_VOICE_ID) {
    const key = env.CARTESIA_API_KEY;
    const voiceId = env.CARTESIA_VOICE_ID;
    p.tts = (line, emotion) =>
      cartesiaTts(line, { voiceId, emotion, model: env.CARTESIA_MODEL, version: env.CARTESIA_VERSION }, key);
    enabled.push("cartesia");
  }
  return { providers: p, enabled };
}

const MAX_BYTES = 8 * 1024 * 1024; // a preview should never be this big; protects storage

export async function downloadAudio(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get("content-type")?.split(";")[0] || guessType(url);
  if (!contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
    throw new Error(`not audio (${contentType})`);
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) throw new Error("file too large");
  return { bytes, contentType: contentType === "application/octet-stream" ? guessType(url) : contentType };
}

function guessType(url: string) {
  if (/\.ogg(\?|$)/i.test(url)) return "audio/ogg";
  if (/\.wav(\?|$)/i.test(url)) return "audio/wav";
  return "audio/mpeg";
}
