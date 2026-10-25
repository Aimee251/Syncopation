// Manual browser check of the web app's microphone without API keys: serves the built page (web/dist), the real
// /api/mic with a fake speech service that reports how much audio arrived, and stub /api routes.
//   npm --prefix web run build && npx tsx tests/fixtures/webMicServer.ts --port 8788
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachMic, type SttFactory } from "../../micServer";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8788;
const root = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp" };
let talkToken: string | null = null;
const said: string[] = [];

const stt: SttFactory = (keyterms, on) => {
  let bytes = 0; const t0 = Date.now();
  return {
    send: pcm => { bytes += pcm.length; on.partial(`heard ${(bytes / 32000).toFixed(1)} s of audio`); },
    finish: ended => { on.final(`a story told in ${(bytes / 32000).toFixed(1)} seconds at ${Math.round(bytes / ((Date.now() - t0) / 1000))} bytes per second`); setTimeout(ended, 10); },
    close: () => { },
  };
};
const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://x");
  const json = (b: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
  if (url.pathname === "/api/start") { let s = ""; req.on("data", c => (s += c)); req.on("end", () => { said.push(JSON.parse(s).theme); console.log(`[stub] theme: ${said.at(-1)}`); json({ id: "stub" }); }); return; }
  if (url.pathname === "/api/status") return json({ state: "ready" });
  if (url.pathname === "/api/talk") { talkToken = "stub-token"; return json({ ok: true, micToken: talkToken }); }
  if (url.pathname === "/api/stop") { talkToken = null; return json({ ok: true }); }
  let file = resolve(root, "." + url.pathname);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
let lastLog = 0;
attachMic(server, {
  token: () => talkToken, keyterms: () => [],
  hear: (op, text) => { if (op === "final" || Date.now() - lastLog > 2000) { lastLog = Date.now(); console.log(`[stub] talk ${op}: ${text}`); } },
}, { stt });
server.listen(port, () => console.log(`web mic check on http://localhost:${port}`));
