// Tiny local server for the STT latency benchmark. No dependencies (Node 18+).
//
//   CARTESIA_API_KEY=sk_car_... node bench/server.mjs
//   → open http://localhost:5174 in Chrome
//
// It serves bench.html and mints short-lived Cartesia access tokens, so the API key
// never reaches the browser (Cartesia's guidance: tokens in browsers, keys on servers).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = Number(process.env.PORT || 5174);
const KEY = process.env.CARTESIA_API_KEY;
const VERSION = process.env.CARTESIA_VERSION || "2026-08-14";
const here = dirname(fileURLToPath(import.meta.url));

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await readFile(join(here, "bench.html")));
    }
    if (req.method === "POST" && req.url === "/token") {
      if (!KEY) return json(res, 500, { error: "CARTESIA_API_KEY is not set on the server" });
      const r = await fetch("https://api.cartesia.ai/access-token", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "Cartesia-Version": VERSION, "content-type": "application/json" },
        body: JSON.stringify({ grants: { stt: true }, expires_in: 300 }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return json(res, r.status, { error: body.message || body.title || `HTTP ${r.status}` });
      return json(res, 200, { token: body.token, version: VERSION });
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}).listen(PORT, () => {
  console.log(`STT benchmark → http://localhost:${PORT}  (Cartesia key ${KEY ? "loaded" : "MISSING"})`);
});

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
