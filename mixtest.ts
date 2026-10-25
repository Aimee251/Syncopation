// mixtest.ts — renders a short scripted soundtrack to mix.wav (no speakers) to check the mixer
import { setLoop, playOnce, stopAll, setLevel, preload, setMixLogger, speaking, playerName } from "./player";
const D = "sessions/spooky_story_10242116/sounds/";
setMixLogger(m => console.log("MIXCHECK", m));
console.log(playerName());
console.log(preload([["music_calm_0", "music"], ["music_terror_0", "music"], ["hit_0", "stinger"]].map(([id, role]) => ({ id, role, file: `${D}${id}.mp3` }))).join("\n"));
const at = (s: number, f: () => void) => setTimeout(f, s * 1000);
setLoop("music", D + "music_calm_0.mp3", 0.3);
at(3, () => playOnce(D + "footsteps_0.mp3", 0.6, { role: "sfx" }));
at(6, () => { speaking(); playOnce(D + "door_creak_0.mp3", 0.6, { role: "sfx" }); });
at(9, () => setLoop("music", D + "music_terror_0.mp3", 0.6));
at(16, () => playOnce(D + "thunder_0.mp3", 0.8, { role: "sfx" }));
at(18, () => playOnce(D + "hit_0.mp3", 0.9, { role: "stinger" }));
at(24, () => stopAll());
