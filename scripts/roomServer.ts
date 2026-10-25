// scripts/roomServer.ts — the Syncopation room server: the presenter only needs a phone.
//
//   npm run room                 (reads API keys from .env)
//
// Host phone: Share a story → Become host → describe the story (or pick a saved one) → Start talk → type the talk.
// Each room runs its own talk process on this server; audience phones join with the code and play the sound.

import { startRoomHost } from "../room/host";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const missing = ["ANTHROPIC_API_KEY", "FREESOUND_API_KEY"].filter(k => !process.env[k]);
if (missing.length) console.log(`Note: ${missing.join(" and ")} not set — building new sounds or running a talk will fail; saved sessions can still be picked.`);

const room = await startRoomHost({ port: Number(arg("port") ?? process.env.ROOM_PORT ?? 5176), talks: { sessionsDir: arg("sessions") } });
console.log(`Syncopation rooms on ${room.urls.join("  or  ")}`);
console.log(`Sessions folder: ${room.talks!.sessionsDir}`);
