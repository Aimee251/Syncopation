// room/server.ts — the speaker-room network layer: one HTTP server, WebSocket at /room, RoomManager behind it.
//
//   const srv = await startRoomServer({ port: 5176 });   // srv.manager.playCue(roomId, …) from the cue adapter
//
// Listens on all interfaces so phones on the network can reach it. Phones need HTTPS / WSS in a real deployment
// (put a TLS proxy or tunnel in front); plain ws:// is only for local testing.
// Origins are checked on upgrade: a page from an unlisted site can't open a socket with the visitor's browser.
// Tokens travel inside messages, never in the URL, and nothing here logs message bodies.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { MAX_MESSAGE_BYTES } from "./protocol.js";
import { RoomManager, type Conn, type RoomConfig } from "./rooms";

export type RoomServerOptions = {
  port?: number;
  host?: string;
  /** Extra allowed page origins (e.g. "https://syncopation.example"). Same host as the request is always allowed. */
  allowedOrigins?: string[];
  config?: Partial<RoomConfig>;
  manager?: RoomManager;
  /** Other HTTP routes (pages, audio files); return true when handled. */
  handle?: (req: IncomingMessage, res: import("node:http").ServerResponse) => boolean;
  /** Other WebSocket paths (e.g. /room/mic), each with its own frame size limit. Same origin check as /room. */
  sockets?: Record<string, { maxPayload: number; attach(ws: WebSocket, req: IncomingMessage): void }>;
};

export type RoomServer = { url: string; port: number; manager: RoomManager; server: Server; close(): Promise<void> };

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function originAllowed(origin: string | undefined, hostHeader: string | undefined, allowed: string[]): boolean {
  if (!origin) return true; // not a browser (curl, tests, native): origin checks protect browsers only
  if (allowed.includes(origin)) return true;
  try { return !!hostHeader && new URL(origin).host === hostHeader; } catch { return false; }
}

export function startRoomServer(opts: RoomServerOptions = {}): Promise<RoomServer> {
  const manager = opts.manager ?? new RoomManager({ config: opts.config });
  const allowed = opts.allowedOrigins ?? [];
  const server = createServer((req, res) => {
    if (opts.handle?.(req, res)) return;
    if (req.url === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const extra = Object.entries(opts.sockets ?? {}).map(([path, s]) => ({ path, s, wss: new WebSocketServer({ noServer: true, maxPayload: s.maxPayload }) }));

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    const other = extra.find(e => e.path === path);
    if ((path !== "/room" && !other) || !originAllowed(req.headers.origin, req.headers.host, allowed)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
    if (other) return other.wss.handleUpgrade(req, socket, head, ws => other.s.attach(ws, req));
    wss.handleUpgrade(req, socket, head, ws => attach(ws, req));
  });

  function attach(ws: WebSocket, req: IncomingMessage) {
    const ip = req.socket.remoteAddress ?? "";
    const conn: Conn = {
      id: randomUUID(), ip, loopback: LOOPBACK.has(ip),
      send: msg => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
      close: (code = 1000, reason = "") => ws.close(code, reason.slice(0, 120)),
    };
    manager.connect(conn);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return conn.send({ protocolVersion: 1, type: "error", code: "bad_message", message: "text frames only" });
      manager.receive(conn, data.toString());
    });
    ws.on("close", () => manager.disconnect(conn));
    ws.on("error", () => ws.terminate());
  }

  const timer = setInterval(() => manager.tick(), 1000);
  timer.unref();

  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? Number(process.env.ROOM_PORT || 5176), opts.host ?? "0.0.0.0", () => {
      const port = (server.address() as AddressInfo).port;
      ok({
        url: `http://localhost:${port}`, port, manager, server,
        close: () => new Promise<void>(done => {
          clearInterval(timer);
          for (const id of manager.roomIds()) manager.endRoom(id, "server_restart");
          for (const w of [wss, ...extra.map(e => e.wss)]) { w.clients.forEach(c => c.terminate()); w.close(); }
          server.close(() => done());
        }),
      });
    });
  });
}
