// stt.ts — live voice → text. Separate from the prediction model on purpose:
// swap the speech-to-text provider here without touching predict.ts.
//
//   Run alone to test your mic + key:   npx tsx --env-file=.env stt.ts
//   Streams with a Deepgram key (words appear while you talk); --phrase forces phrase-by-phrase
//   Needs sox (macOS: brew install sox) and DEEPGRAM_API_KEY or ELEVENLABS_API_KEY.

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const flag = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? Number(process.argv[i + 1]) : undefined; };

// Input: one phrase of mic audio as a 16 kHz mono 16-bit WAV (Buffer). Output: the words.
// Uses whichever key is set. Add another provider by adding a branch.
export async function transcribe(wav: Buffer): Promise<string> {
  try {
    if (process.env.DEEPGRAM_API_KEY) {
      const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true", {
        method: "POST",
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": "audio/wav" },
        body: new Uint8Array(wav),
      });
      const data: any = await res.json();
      if (!res.ok) throw new Error(data?.err_msg ?? JSON.stringify(data));
      return data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    }
    if (process.env.ELEVENLABS_API_KEY) {
      const form = new FormData();
      form.append("model_id", process.env.ELEVENLABS_STT_MODEL ?? "scribe_v1");
      form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "phrase.wav");
      const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, body: form,
      });
      const data: any = await res.json();
      if (!res.ok) throw new Error(data?.detail?.message ?? JSON.stringify(data));
      return data.text ?? "";
    }
  } catch (e) {
    console.error("[STT] failed:", (e as Error).message);
  }
  return ""; // no key set
}

// Records ONE PHRASE from the default mic: starts when you speak, stops after ~1 s of silence
// (max 15 s). Cutting on pauses keeps sentences whole, which the prediction needs.
const MIC_THRESHOLD = `${flag("mic-threshold") ?? 2}%`; // raise it in a noisy room
export function recordPhrase(onWaiting?: (msg: string) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sox = spawn("sox", ["-q", "-d", "-t", "wav", "-r", "16000", "-c", "1", "-b", "16", "-",
      "silence", "1", "0.1", MIC_THRESHOLD, "1", "1.0", MIC_THRESHOLD, "trim", "0", "15"]);
    const parts: Buffer[] = [];
    let bytes = 0;
    sox.stdout.on("data", d => { parts.push(d); bytes += d.length; });
    // Nothing above the threshold for a while → say so, instead of hanging silently
    const timer = setInterval(() => {
      if (bytes <= 44) onWaiting?.(`still waiting for speech above ${MIC_THRESHOLD}. Mic blocked or too quiet? Run: npx tsx stt.ts --check`);
    }, 10_000);
    sox.on("error", () => { clearInterval(timer); reject(new Error("sox not found. Install it (macOS: brew install sox) or run with --type")); });
    sox.on("close", () => { clearInterval(timer); resolve(Buffer.concat(parts)); });
  });
}

// Records exactly N seconds, no silence detection (used by --check)
function recordSeconds(sec: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sox = spawn("sox", ["-q", "-d", "-t", "wav", "-r", "16000", "-c", "1", "-b", "16", "-", "trim", "0", String(sec)]);
    const parts: Buffer[] = [];
    sox.stdout.on("data", d => parts.push(d));
    sox.on("error", () => reject(new Error("sox not found. Install it: brew install sox")));
    sox.on("close", () => resolve(Buffer.concat(parts)));
  });
}

// Mic loudness 0..100, to tell "mic heard nothing" apart from "speech-to-text failed"
export function level(wav: Buffer): number {
  let sum = 0, n = 0;
  for (let i = 44; i + 1 < wav.length; i += 2) { const v = wav.readInt16LE(i) / 32768; sum += v * v; n++; }
  return Math.min(100, Math.round(Math.sqrt(sum / Math.max(n, 1)) * 400));
}

export const hasSttKey = () => !!(process.env.DEEPGRAM_API_KEY || process.env.ELEVENLABS_API_KEY);

// STREAMING (Deepgram): words arrive WHILE you speak.
//   onPartial(text) — the current sentence so far, updated every ~0.3 s
//   onFinal(text)   — the whole sentence once you pause
// Mic audio is piped straight from sox into a live Deepgram connection.
// Words the speech model should favour (the sound library's trigger phrases); set before listen()
let keyterms: string[] = [];
export const setKeyterms = (list: string[]) => { keyterms = [...new Set(list.map(k => k.trim()).filter(k => k.length > 2))]; };

async function listenStreaming(onPartial: (t: string) => void, onFinal: (t: string) => void, onInfo: (m: string) => void): Promise<never> {
  const WS = (globalThis as any).WebSocket;
  const url = "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
    "&interim_results=true&smart_format=true&endpointing=300&utterance_end_ms=1000" +
    keyterms.slice(0, 80).map(k => `&keyterm=${encodeURIComponent(k)}`).join(""); // nova-3 key terms: the trigger words get heard right
  const ws = new WS(url, ["token", process.env.DEEPGRAM_API_KEY]); // Deepgram accepts the key as a subprotocol
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("couldn't connect to Deepgram streaming (check the key / network)"));
  });
  onInfo("streaming: words appear while you talk");

  let done = "";      // finalized parts of the current sentence
  let lastSent = "";
  const flush = () => {
    const text = done.trim();
    done = ""; lastSent = "";
    if (text) onFinal(text);
  };
  ws.onmessage = (ev: any) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (msg.type === "UtteranceEnd") return flush();               // backup end-of-sentence signal
    if (msg.type !== "Results") return;
    const t: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
    if (msg.is_final) done += (t ? " " + t : "");
    const current = (done + (msg.is_final ? "" : " " + t)).trim();
    if (current && current !== lastSent) { lastSent = current; onPartial(current); }
    if (msg.speech_final) flush();                                   // you paused: the sentence is complete
  };
  ws.onclose = (ev: any) => { onInfo(`Deepgram closed the connection (${ev.code}${ev.reason ? " " + ev.reason : ""})`); process.exit(1); };

  const micArgs = process.env.MIC_DEVICE ? (["-t", "coreaudio", process.env.MIC_DEVICE] as string[]) : ["-d"]; // MIC_DEVICE avoids the Bluetooth headset profile
  const sox = spawn("sox", ["--buffer", "1024", "-q", ...micArgs, "-t", "raw", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-"]); // small buffer: words reach the STT sooner
  sox.on("error", () => { onInfo("sox not found. Install it (macOS: brew install sox) or run with --type"); process.exit(1); });
  sox.stdout.on("data", (chunk: Buffer) => { if (ws.readyState === 1) ws.send(chunk); });
  setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "KeepAlive" })); }, 8000);
  return new Promise<never>(() => { });
}

// Listens forever. With a Deepgram key (and Node 22+) it streams: partial text while you talk + the final sentence.
// Otherwise (ElevenLabs key, or --phrase) it records one phrase at a time and only gives the final sentence.
export async function listen(onText: (text: string) => void, onInfo: (msg: string) => void = console.log,
  onPartial?: (text: string, lagMs?: number) => void): Promise<never> {
  if (!hasSttKey()) onInfo("no DEEPGRAM_API_KEY or ELEVENLABS_API_KEY set: you'll see mic levels but no text");
  if (process.env.DEEPGRAM_API_KEY && (globalThis as any).WebSocket && !process.argv.includes("--phrase")) {
    try { return await listenStreaming(onPartial ?? (() => { }), onText, onInfo); }
    catch (e) { onInfo(`${(e as Error).message} → falling back to phrase-by-phrase`); }
  }
  let queue = Promise.resolve();
  while (true) {
    let wav: Buffer;
    try { wav = await recordPhrase(onInfo); }
    catch (e) { onInfo((e as Error).message); process.exit(1); }
    queue = queue.then(async () => {
      const t0 = Date.now();
      const text = (await transcribe(wav)).trim();
      if (!text) return onInfo(`phrase ${(wav.length / 32000).toFixed(1)} s, level ${level(wav)}/100, no text`);
      onInfo(`transcribed in ${Date.now() - t0} ms`);
      onText(text);
    });
  }
}

// Standalone test: just prints what it hears
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    // Mic check: 3 s of raw audio → loudness, then send it to speech-to-text once
    (async () => {
      console.log("Talk normally for 3 seconds…");
      const wav = await recordSeconds(3);
      const lv = level(wav);
      console.log(`Mic level: ${lv}/100 ${lv < 2 ? "→ basically silent: check microphone permission for your terminal" : lv < 8 ? "→ quiet: try --mic-threshold 1" : "→ OK"}`);
      console.log(`Speech-to-text says: "${await transcribe(wav)}"`);
    })();
  } else {
    console.log(`Speak — each phrase prints below (starts above ${MIC_THRESHOLD} loudness). Ctrl+C to stop.\n`);
    let t0 = 0;
    listen(text => { console.log(`\n> ${text}`); t0 = 0; }, msg => console.log(`  (${msg})`),
      partial => { if (!t0) t0 = Date.now(); process.stdout.write(`\r  … ${partial.slice(-90)}`); });
  }
}
