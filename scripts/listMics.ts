// npm run mics — lists the microphones (input devices) on this Mac, so you can pick one:
//   npm run dev -- --mic "Shure MV7"        (or put MIC_DEVICE=Shure MV7 in .env)
import { spawnSync } from "node:child_process";
export {};

const r = spawnSync("system_profiler", ["SPAudioDataType", "-json"], { encoding: "utf8" });
if (r.status !== 0) { console.log("Couldn't read the audio devices (this needs macOS)."); process.exit(1); }
const items: any[] = JSON.parse(r.stdout).SPAudioDataType?.[0]?._items ?? [];
const mics = items.filter(d => Number(d.coreaudio_device_input ?? 0) > 0);
if (!mics.length) { console.log("No input devices found. Plug in the mic, or check System Settings → Sound → Input."); process.exit(0); }
console.log("Microphones on this Mac:\n");
for (const d of mics) {
  const isDefault = d.coreaudio_default_audio_input_device === "spaudio_yes";
  console.log(`  ${isDefault ? "★" : " "} ${d._name}   (${d.coreaudio_device_input} channel${Number(d.coreaudio_device_input) > 1 ? "s" : ""}${d.coreaudio_device_transport ? `, ${String(d.coreaudio_device_transport).replace("coreaudio_device_type_", "")}` : ""})`);
}
console.log(`\n★ = the Mac's current default input.\nUse one:   npm run dev -- --mic "${mics[0]._name}"\nOr always: add  MIC_DEVICE=${mics[0]._name}  to .env`);
console.log("Tip: Bluetooth headphones used as the mic drop to low-quality call audio; a wired / USB mic or the laptop mic sounds better.");
