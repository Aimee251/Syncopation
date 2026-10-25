// Freesound APIv2 text search. Token auth (no OAuth needed for search + previews).
// Get a key at https://freesound.org/apiv2/apply
// We download the HQ MP3 *preview* (~128 kbps), which is plenty for playback
// and avoids the OAuth2 flow that original-file downloads require.

import type { Candidate } from "../types";

const BASE = "https://freesound.org/apiv2/search/text/";
const FIELDS = "id,name,tags,duration,license,username,previews,avg_rating,num_downloads,url";

/** Only licenses that allow live/commercial use. CC-BY needs a credit line (we store it). */
const LICENSE_FILTER = 'license:("Creative Commons 0" OR "Attribution")';

export interface FreesoundOpts {
  minDurationS: number;
  maxDurationS: number;
  loop?: boolean; // music beds: prefer loops
  pageSize?: number;
}

// PACING: Freesound allows ~60 requests/minute per key. Bursts (24 searches at once) tripped the limit within seconds and the
// sounds behind them went missing. Searches now take a token from a bucket (8 at once, refilled at 50/min) and wait their
// turn instead — slower by a second or two in a burst, but nothing is refused.
// a burst of 14 lets the whole first batch search at once (no waiting at startup); refilled at 45/min → never over 60/min
const BUCKET = { tokens: 14, max: 14, perMs: 60_000 / 45, last: Date.now() };
async function takeToken() {
  for (;;) {
    const now = Date.now();
    BUCKET.tokens = Math.min(BUCKET.max, BUCKET.tokens + (now - BUCKET.last) / BUCKET.perMs);
    BUCKET.last = now;
    if (BUCKET.tokens >= 1) { BUCKET.tokens -= 1; return; }
    await new Promise((r) => setTimeout(r, Math.ceil((1 - BUCKET.tokens) * BUCKET.perMs)));
  }
}
export const freesoundRequests = { count: 0 };

export async function searchFreesound(query: string, opts: FreesoundOpts, token: string): Promise<Candidate[]> {
  await takeToken();
  freesoundRequests.count++;
  const filter = [
    `duration:[${opts.minDurationS} TO ${opts.maxDurationS}]`,
    LICENSE_FILTER,
    opts.loop ? "tag:loop" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const params = new URLSearchParams({
    query,
    filter,
    fields: FIELDS,
    page_size: String(opts.pageSize ?? 15),
    token,
  });
  const res = await fetch(`${BASE}?${params}`);
  if (res.status === 429) throw new Error("Freesound rate limit hit");
  if (!res.ok) throw new Error(`Freesound HTTP ${res.status}`);
  const data = (await res.json()) as { results?: any[] };
  return (data.results ?? [])
    .map((r): Candidate | null => {
      const url = r.previews?.["preview-hq-mp3"] ?? r.previews?.["preview-lq-mp3"];
      if (!url) return null;
      const license = licenseName(String(r.license ?? ""));
      return {
        source: "freesound",
        sourceId: String(r.id),
        name: String(r.name ?? ""),
        tags: (r.tags ?? []).map((t: string) => t.toLowerCase()),
        durationS: Number(r.duration ?? 0),
        audioUrl: url,
        license,
        attribution: license === "CC0" ? undefined : `"${r.name}" by ${r.username} (freesound.org, ${license})`,
        pageUrl: r.url,
        rating: Number(r.avg_rating ?? 0),
        downloads: Number(r.num_downloads ?? 0),
      };
    })
    .filter((c): c is Candidate => c !== null);
}

function licenseName(url: string): string {
  if (url.includes("publicdomain/zero")) return "CC0";
  if (url.includes("/by-nc")) return "CC-BY-NC"; // filtered out above, kept for safety
  if (url.includes("/by/")) return "CC-BY";
  return url || "unknown";
}
