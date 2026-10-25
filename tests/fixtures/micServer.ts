// Manual check of the host page's microphone in a real browser, without API keys: the fake talk process, and a fake
// speech service that reports how much audio arrived and at what rate (16 kHz 16-bit mono = 32 000 bytes/s).
//   npx tsx tests/fixtures/micServer.ts --sessions ../Syncopation/sessions --port 5178
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startRoomHost } from "../../room/host";
import type { SttFactory } from "../../room/deepgram";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const stt: SttFactory = (keyterms, on) => {
  let bytes = 0, frames = 0; const t0 = Date.now();
  console.log(`[stt] opened, ${keyterms.length} key terms`);
  const timer = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    on.partial(`audio ${(bytes / 32000).toFixed(1)} s in ${s.toFixed(1)} s (${Math.round(bytes / s)} bytes/s, ${frames} frames)`);
  }, 1000);
  return { send: pcm => { bytes += pcm.length; frames++; }, close: () => { clearInterval(timer); console.log(`[stt] closed after ${bytes} bytes`); } };
};
const host = await startRoomHost({
  port: Number(arg("port") ?? 5178), stt,
  talks: {
    sessionsDir: arg("sessions"),
    spawnTalk: ({ library, setup }) => spawn(process.execPath, ["--import", "tsx", "tests/fixtures/fakeTalk.ts", "--library", library, "--setup", setup, "--type"],
      { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, SYNC_ROOM_IPC: "1" } }),
  },
});
console.log(`mic test server on ${host.urls.join("  ")}`);
