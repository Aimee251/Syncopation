// audio.ts — local playback for the terminal test (macOS afplay).
// SFX are one-shots layered on top; music is one looping bed that is swapped when the mood changes.
// Limits of afplay: no crossfade and no live volume change. A running process keeps its start volume,
// so the music volume is set at each (re)start. The Tone.js output phone replaces this later.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

const PLAYER = "/usr/bin/afplay";
const clamp = (v: number, lo = 0.05, hi = 1) => Math.max(lo, Math.min(hi, v));

class AudioEngine {
  enabled = existsSync(PLAYER);
  private sfx = new Set<ChildProcess>();
  private bed: ChildProcess | null = null;
  private bedKey = "";

  /** One-shot effect, layered over whatever else is playing. */
  playSfx(file: string | undefined, volume = 0.8) {
    if (!this.enabled || !file || !existsSync(file)) return;
    const p = spawn(PLAYER, ["-v", clamp(volume).toFixed(2), file], { stdio: "ignore" });
    this.sfx.add(p);
    p.on("exit", () => this.sfx.delete(p));
    p.on("error", () => this.sfx.delete(p));
  }

  /** Start (or switch to) a looping music bed. Same key + still playing = no-op. */
  playMusic(key: string, file: string | undefined, volume = 0.3) {
    if (!this.enabled || !file || !existsSync(file)) return;
    if (key === this.bedKey && this.bed) return;
    this.stopMusic();
    this.bedKey = key;
    const loop = () => {
      if (this.bedKey !== key) return;
      const p = spawn(PLAYER, ["-v", clamp(volume).toFixed(2), file], { stdio: "ignore" });
      this.bed = p;
      p.on("exit", code => { if (this.bed === p) { this.bed = null; if (code === 0) loop(); } });
      p.on("error", () => { if (this.bed === p) this.bed = null; });
    };
    loop();
  }

  stopMusic() {
    this.bedKey = "";
    this.bed?.kill("SIGTERM");
    this.bed = null;
  }

  /** Cut every effect that is still sounding (used by /skip). */
  stopSfx() {
    this.sfx.forEach(p => p.kill("SIGTERM"));
    this.sfx.clear();
  }

  stopAll() { this.stopMusic(); this.stopSfx(); }
}

export const audio = new AudioEngine();
process.on("exit", () => audio.stopAll());
