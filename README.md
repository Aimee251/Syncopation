# Syncopation

## Run the app (web front end + backend)

```bash
npm install
npm run app            # backend on :8787 + the web app on :5173 → open http://localhost:5173 in Chrome or Safari
npm run app -- --mic "Shure MV7"   # another microphone for the talk (names: npm run mics)
npm run app -- --phone            # serve the web app over HTTPS so a phone on the same Wi-Fi can open it
```

Hold the button and say your theme → planning and fetching start the moment you let go → turn the wheel →
the glowing orb shows while the first sounds load → the talk starts (laptop mic in, sounds out of the laptop).
Tap the page to end the talk; the report prints in the terminal. The web app lives in `web/`, the bridge is `server.ts`.
Terminal-only mode is still `npm run dev`.


1. sox is not installed (Fatal Exit)


stt.ts
 uses the sox command-line utility to record audio from your microphone. Because sox is not found, the script throws an error and exits immediately.

Fix: Install sox via Homebrew:

bash
brew install sox


