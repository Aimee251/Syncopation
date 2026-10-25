// room/assets.ts — which audio files phones may load (spec §6). A file becomes an asset with an id and a content hash;
// phones fetch it from /assets/<assetId><ext> on this server and cache it by hash. Nothing outside the registry is served,
// so a phone can never be pointed at an arbitrary file or remote URL.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Asset } from "./rooms";

const TYPES: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4" };

export class AssetRegistry {
  private byFile = new Map<string, Asset>();   // absolute path → asset
  private byId = new Map<string, string>();    // assetId → absolute path
  /** Durations the scraper already measured (library.json durationMs), so the server needn't decode audio. */
  private knownDurations = new Map<string, number>();

  /** Read durations from a library.json written by the scraper (sessions/<id>/library.json). */
  learnLibrary(libraryFile: string) {
    if (!existsSync(libraryFile)) return;
    try {
      const raw = JSON.parse(readFileSync(libraryFile, "utf8"));
      for (const r of Array.isArray(raw) ? raw : raw.sounds ?? []) {
        if (r?.url && Number.isFinite(r.durationMs)) this.knownDurations.set(resolve(dirname(libraryFile), String(r.url).replace(/^\//, "")), r.durationMs / 1000);
      }
    } catch { /* unreadable library: durations come from the phones' decoders instead */ }
  }

  /** Register a file (idempotent). Returns the asset, or null for a missing or unsupported file. */
  add(file: string): Asset | null {
    const abs = resolve(file);
    const have = this.byFile.get(abs);
    if (have) return have;
    const mimeType = TYPES[extname(abs).toLowerCase()];
    if (!mimeType || !existsSync(abs) || !statSync(abs).isFile()) return null;
    const contentHash = createHash("sha256").update(readFileSync(abs)).digest("hex");
    // readable and unique: the file's name plus a slice of its hash (two "thunder_0.mp3" from different sessions differ)
    const stem = basename(abs, extname(abs)).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
    const assetId = `${stem}.${contentHash.slice(0, 12)}`;
    const asset: Asset = { assetId, contentHash, url: `/assets/${assetId}${extname(abs).toLowerCase()}`, mimeType, durationS: this.knownDurations.get(abs) ?? 0 };
    this.byFile.set(abs, asset);
    this.byId.set(assetId, abs);
    return asset;
  }

  get(file: string) { return this.byFile.get(resolve(file)) ?? null; }
  list(): Asset[] { return [...this.byFile.values()]; }

  /** /assets/<assetId><ext> → file on disk, only for registered assets. */
  fileForUrl(urlPath: string): { file: string; mimeType: string } | null {
    const m = /^\/assets\/([A-Za-z0-9_.-]+?)(\.[a-z0-9]+)$/.exec(urlPath);
    const file = m ? this.byId.get(m[1]) : undefined;
    const asset = file ? this.byFile.get(file) : undefined;
    return asset && asset.url === urlPath ? { file: file!, mimeType: asset.mimeType } : null;
  }
}

export const libraryFor = (soundFile: string) => join(dirname(dirname(resolve(soundFile))), "library.json");
