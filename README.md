# Syncopation

## Run the app (web front end + backend)

```bash
npm install
npm run app            # backend on :8787 + the web app on :5173 → open http://localhost:5173 in Chrome or Safari
npm run app -- --phone            # serve the web app over HTTPS so a phone on the same Wi-Fi can open it
npm run app -- --laptop-mic       # the talk listens to this machine's mic instead of the browser's (old behaviour)
npm run app -- --laptop-mic --mic "Shure MV7"   # …and picks which one (names: npm run mics)
```

Hold the button and say your theme → planning and fetching start the moment you let go → turn the wheel →
the glowing orb shows while the first sounds load → the talk starts (the phone's mic in, sounds out of the laptop).
Tap the page to end the talk; the report prints in the terminal. The web app lives in `web/`, the bridge is `server.ts`.

**Microphone:** the page streams the microphone of whatever device opened it (phone, tablet, another laptop) to the
backend, which transcribes it with Deepgram and feeds the words to the talk as they're heard (`micServer.ts`). Needs
`DEEPGRAM_API_KEY` in `.env` and an **https://** page (Vercel, a cloudflared tunnel, or `--phone`): browsers only allow
the microphone on secure pages. Without a Deepgram key the theme falls back to the browser's own recognition, but the
talk can't hear the phone (use `--laptop-mic`). Tests: `npm run test:mic`.
Terminal-only mode is still `npm run dev`.


1. sox is not installed (Fatal Exit)


stt.ts
 uses the sox command-line utility to record audio from your microphone. Because sox is not found, the script throws an error and exits immediately.

Fix: Install sox via Homebrew:

bash
brew install sox


