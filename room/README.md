# Speaker rooms

Phones in the room join a story with a six-digit code and play the soundtrack together. The presenter's machine decides
every sound (as before); the room schedules each one ~400 ms ahead and every phone plays it at the same server time.

## Run it

**Phone-only (the server runs the talk):**

```bash
npm run room
```

Reads API keys from `.env` (`ANTHROPIC_API_KEY`, `FREESOUND_API_KEY`, optional ElevenLabs / Apify / Cartesia, like `npm run dev`).
Host phone: **Share a story → Become host** → describe the story (or reuse a saved one) → wait for the sounds →
**Start talk** → **Use microphone** and tell the story (or type it a sentence at a time). **Wrong sound / Good sound** teach the scorer (`/skip`, `/good`);
**End talk** finishes it and the next story can be set up in the same room. Each room's talk runs as its own
`predict.ts` process (`room/talks.ts`); at most 3 at once by default.

**Microphone:** the host phone streams 16 kHz audio to the server (`/room/mic`), which transcribes it with Deepgram
(`DEEPGRAM_API_KEY`, same settings as `stt.ts`) and feeds the words to the talk as they're heard. Phone browsers only
allow the microphone on **https://** pages, so put the server behind HTTPS for this, e.g. a tunnel:

```bash
cloudflared tunnel --url http://localhost:5176
```

Open the printed `https://…` address on the phones. If the page loads but can't connect, add that address to
`ROOM_ALLOWED_ORIGINS` in `.env`. Plain `http://` on Wi-Fi still works for everything except the microphone.

Try it with a saved session, no talk or API keys needed (a scripted soundtrack that repeats every 40 s):

```bash
npx tsx scripts/roomDemo.ts --session sessions/spooky_story_10242116
```

With a real talk (typed or spoken), the sound goes to the room instead of this machine's speakers:

```bash
npm run dev -- --room
```

Open the printed address on phones on the same Wi-Fi. One phone: **Share a story → Become host**. The others:
**Share a story → Join a story**, enter the code, tap **Enable sound**. The host presses **Start talk** when the phones are Ready.

Tests: `npm run test:room`

## Files

| File | Role |
|---|---|
| `room/protocol.js` | Message contract and validation (server and phones) |
| `room/clock.js` | Clock offset, audio-time conversion, late cues, loop phase (server, phones, tests) |
| `room/rooms.ts` | Rooms, codes, tokens, roles, readiness, cues, mute generations, expiry |
| `room/server.ts` | HTTP + WebSocket (`/room`), origin check |
| `room/assets.ts` | Which audio files phones may load, by content hash |
| `room/engine.ts` | Cue adapter: `mixer.ts` calls → room cues |
| `room/talks.ts` | Server-run talks: setup / saved story, scraping, one `predict.ts` process per room, typed input |
| `room/talkBridge.ts` | IPC between a talk process's `mixer.ts` and its room's engine (files limited to its session folder) |
| `room/mic.ts`, `room/deepgram.ts` | Host-only microphone socket → Deepgram streaming → words into the talk |
| `public/room/mic.js`, `mic-worklet.js` | Phone side: capture with echo cancellation, convert to 16 kHz PCM, stream |
| `room/host.ts` | Starts all of the above and serves the pages |
| `public/room/*` | Pages (`/`, `/host`, `/join`), phone audio scheduler, connection, member logic |

## Limits (MVP)

- Rooms live in this process's memory: a restart ends every room.
- `--room` / demo (laptop mode): one talk per process; the first room whose host presses Start gets the sound.
- The microphone needs HTTPS and a Deepgram key; without either, typing still works.
- Echo cancellation only removes the host phone's own output. Other phones' sound can reach the mic: keep it close
  to the presenter's mouth and the host phone's own speaker off (the default).
- `weights.json` (what the scorer learns) is shared by all talks on a server.
- Plain `http://` works on a local network. A deployment needs HTTPS / WSS in front (set `ROOM_ALLOWED_ORIGINS`).
- Low-pass and reverb on effects (`lowpassHz`, `wet`) aren't sent to phones yet.
- Phones pause pages in the background: keep the page open and the screen on.

## Manual demo checklist

1. Host and 2+ phones reach **Ready**; the host's counts match.
2. **Test sound** plays on every phone.
3. **Start talk**: music and effects play on all phones; listen for echo between phones.
4. **Mute all** silences everything at once; **Resume audio** brings the music back mid-track, not from the start.
5. A phone's **Mute this phone** stays muted through Resume.
6. Lock joining → a new phone sees "closed to new phones".
7. Reload a phone mid-talk → it rejoins without the code, taps Enable sound, plays on.
8. Turn a phone's Wi-Fi off for 10 s → it fades out, reconnects, and rejoins the music at the right point.
9. End room → every phone shows "The story has ended".

Not measured yet: how closely real phones line up acoustically, and how much louder several phones are. Record those
with an external recorder (spec §11) before claiming either.
