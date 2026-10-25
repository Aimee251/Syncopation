// room/host.ts — everything a speaker room needs in one call: room service + WebSocket, the pages, the audio files,
// and the engine that predict.ts sends its sound decisions to.
//
//   const room = await startRoomHost({ files });            // laptop: this process's talk plays in the first started room
//   const room = await startRoomHost({ talks: {} });        // server: every room runs its own talk (room/talks.ts)
//
// Pages:  /  (Share a story: Become host / Join a story)   /host   /join
// Audio:  /assets/<assetId>.<ext>, only files in the registry

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RoomManager, type RoomConfig } from "./rooms";
import { RoomEngine } from "./engine";
import { TalkManager } from "./talks";
import { MicHub, MIC_LIMITS } from "./mic";
import type { SttFactory } from "./deepgram";
import { startRoomServer, type RoomServer } from "./server";

const here = dirname(fileURLToPath(import.meta.url));
const PAGES = join(here, "..", "public", "room");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
// explicit list: nothing else on disk is reachable
const STATIC: Record<string, string> = {
  "/": join(PAGES, "index.html"),
  "/host": join(PAGES, "host.html"),
  "/join": join(PAGES, "join.html"),
  "/room/style.css": join(PAGES, "style.css"),
  "/room/connection.js": join(PAGES, "connection.js"),
  "/room/speaker.js": join(PAGES, "speaker.js"),
  "/room/member.js": join(PAGES, "member.js"),
  "/room/mic.js": join(PAGES, "mic.js"),
  "/room/mic-worklet.js": join(PAGES, "mic-worklet.js"),
  "/room/clock.js": join(here, "clock.js"),
  "/room/protocol.js": join(here, "protocol.js"),
};

export type RoomHost = { server: RoomServer; engine: RoomEngine; manager: RoomManager; talks: TalkManager | null; urls: string[] };

export async function startRoomHost(opts: {
  files?: string[]; port?: number; host?: string; config?: Partial<RoomConfig>; allowedOrigins?: string[]; log?: (m: string) => void;
  talks?: ConstructorParameters<typeof TalkManager>[1];
  /** speech-to-text for the host's microphone (default: Deepgram, when DEEPGRAM_API_KEY is set); server mode only */
  stt?: SttFactory;
} = {}): Promise<RoomHost> {
  const engine = new RoomEngine();
  const manager = new RoomManager({ config: opts.config });
  const talks = opts.talks ? new TalkManager(manager, opts.talks) : null;
  const mic = talks ? new MicHub(manager, talks, { stt: opts.stt }) : null;
  manager.hooks = talks ? talks.hooks() : engine.hooks();
  engine.manager = manager;
  if (opts.log) engine.log = opts.log;
  engine.register(opts.files ?? []);

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const page = STATIC[path];
    if (page && existsSync(page)) {
      res.writeHead(200, { "content-type": TYPES[extname(page)] ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : readFileSync(page));
      return true;
    }
    const asset = talks ? talks.fileForUrl(path) : engine.registry.fileForUrl(path);
    if (asset) {
      // named by content hash: safe to cache for good
      res.writeHead(200, { "content-type": asset.mimeType, "content-length": statSync(asset.file).size, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
      if (req.method === "HEAD") res.end(); else createReadStream(asset.file).pipe(res);
      return true;
    }
    return false;
  };

  const allowed = [...(opts.allowedOrigins ?? []), ...(process.env.ROOM_ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean)];
  const sockets = mic ? { "/room/mic": { maxPayload: MIC_LIMITS.maxFrameBytes, attach: (ws: import("ws").WebSocket) => mic.attach(ws) } } : undefined;
  const server = await startRoomServer({ port: opts.port, host: opts.host, manager, handle, allowedOrigins: allowed, sockets });
  return { server, engine, manager, talks, urls: [...lanAddresses().map(ip => `http://${ip}:${server.port}`), server.url] };
}

/** This machine's addresses on the local network, for phones on the same Wi-Fi. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => a!.address);
}
