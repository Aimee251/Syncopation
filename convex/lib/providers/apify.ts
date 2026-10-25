// Apify: second source when Freesound comes up short.
// Default actor: crawlerbros/mixkit-stock-media-scraper (Mixkit SFX + music,
// royalty-free, no attribution). Any actor that returns rows with an audio URL works;
// set APIFY_ACTOR and, if its input keys differ, APIFY_INPUT_TEMPLATE.
//
// Uses the run-sync-get-dataset-items endpoint, which starts the actor, waits,
// and returns the dataset rows in one HTTP call.
//
// ⚠️ Check the actor's Input tab once: the field names below (searchQuery,
// mediaType, maxItems) are a best guess and the mapper reads several common
// output field names defensively.

import type { Candidate } from "../types";

export interface ApifyOpts {
  actor: string; // "crawlerbros/mixkit-stock-media-scraper"
  layer: "sfx" | "music";
  maxItems?: number;
  timeoutS?: number;
  /** JSON with {{query}}, {{mediaType}}, {{maxItems}} placeholders. Overrides the default input. */
  inputTemplate?: string;
}

export async function searchApify(query: string, opts: ApifyOpts, token: string): Promise<Candidate[]> {
  const actorPath = opts.actor.replace("/", "~");
  const maxItems = opts.maxItems ?? 8;
  const mediaType = opts.layer === "music" ? "music" : "soundEffects";
  const input = opts.inputTemplate
    ? JSON.parse(
      opts.inputTemplate
        .replaceAll("{{query}}", query.replace(/"/g, ""))
        .replaceAll("{{mediaType}}", mediaType)
        .replaceAll("{{maxItems}}", String(maxItems)),
    )
    : { mode: "search", searchQuery: query, mediaType, maxItems };

  const url =
    `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items` +
    `?timeout=${opts.timeoutS ?? 45}&limit=${maxItems}&clean=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}`);
  const rows = (await res.json()) as any[];
  return rows.map(toCandidate).filter((c): c is Candidate => c !== null);
}

function toCandidate(r: any): Candidate | null {
  const audioUrl: string | undefined =
    r.downloadUrl ?? r.audioUrl ?? r.mp3Url ?? r.wavUrl ?? r.previewUrl ?? r.fileUrl ?? r.mediaUrl ??
    (typeof r.url === "string" && /\.(mp3|wav|ogg|m4a)(\?|$)/i.test(r.url) ? r.url : undefined);
  if (!audioUrl) return null;
  const tags = [r.tags, r.categories, r.moods, r.genres]
    .flat()
    .filter((t: unknown): t is string => typeof t === "string")
    .map((t) => t.toLowerCase());
  return {
    source: "apify",
    sourceId: String(r.id ?? r.soundId ?? r.slug ?? audioUrl),
    name: String(r.title ?? r.name ?? "untitled"),
    tags,
    durationS: parseDuration(r.duration ?? r.durationSeconds ?? r.length),
    audioUrl,
    license: String(r.license ?? r.licenseName ?? "Mixkit license"),
    pageUrl: r.pageUrl ?? r.url,
  };
}

/** Accepts 12, "12", "0:12" or "1:02:03". Returns 0 when unknown. */
function parseDuration(d: unknown): number {
  if (typeof d === "number") return d > 1000 ? d / 1000 : d;
  if (typeof d !== "string") return 0;
  if (d.includes(":")) return d.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
  return Number(d) || 0;
}
