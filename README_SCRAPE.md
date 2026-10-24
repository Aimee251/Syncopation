# Scrape service

Setup screen → `sessions.create` → `scrape.run` (Convex action) → sounds in Convex storage → `library.forSession` for the output phone.

```
keywords + theme ──► planner (Claude Haiku, forced tool call; deterministic fallback)
                       │  slots: riser/swell/drone (speculative) + theme SFX + one per keyword
                       │         + one music bed per theme mood + voice lines (if voice on)
                       ▼
             per slot, 6 in parallel:
             Freesound text search (CC0 / CC-BY, duration-filtered)
               └─ too few? Apify actor (Mixkit by default)
             rank (tag overlap, popularity, rating, duration fit) → download top 2
               └─ nothing usable? ElevenLabs generate (SFX or music)
             voice slots → Cartesia TTS (or ElevenLabs SFX if no Cartesia key)
                       ▼
             ctx.storage + `sounds` rows; session.sfxIds/voiceIds = the tracker's enums
```

## Files

| File | What it does |
|---|---|
| `convex/schema.ts` | `sessions`, `scrapeJobs`, `sounds` (+ loose stubs of the later tables) |
| `convex/sessions.ts` | `create` (validates, 4-digit code, schedules the scrape), `get`, `byCode` |
| `convex/scrape.ts` | `run` action, `rerun`, live `status` query, internal mutations |
| `convex/library.ts` | `forSession`: same shape as `public/library.json`, with signed URLs |
| `convex/lib/planner.ts` | Claude plan + fallback + normalisation (layer toggles, base speculative sounds) |
| `convex/lib/pipeline.ts` | Search → rank → download → generate, provider-agnostic |
| `convex/lib/providers/*` | Freesound, Apify, ElevenLabs, Cartesia clients (plain `fetch`, no SDKs) |
| `src/pages/Setup.tsx`, `src/themes.ts` | Steps 1–6 of the user flow with live progress and the pairing code |
| `scripts/buildLibrary.ts` | Same pipeline offline → `public/library.json` + `public/sounds/` |

`convex/lib/` imports nothing from Convex, so the script and the action share every line of logic.

## Setup

```bash
npm i convex react react-dom && npm i -D tsx
npx convex dev                         # generates convex/_generated
npx convex env set FREESOUND_API_KEY …   # https://freesound.org/apiv2/apply  (required, or one of the two below)
npx convex env set ANTHROPIC_API_KEY …   # optional: better plans
npx convex env set ELEVENLABS_API_KEY …  # optional: generation fallback
npx convex env set APIFY_TOKEN …         # optional: second search source
npx convex env set CARTESIA_API_KEY … && npx convex env set CARTESIA_VOICE_ID …   # optional: voice lines
```

Try it without Convex first:

```bash
FREESOUND_API_KEY=… npx tsx scripts/buildLibrary.ts --theme spooky_story \
  --keywords "abandoned house, storm, footsteps, ghost"
```

Optional env: `CLAUDE_MODEL` (default `claude-haiku-5-5`), `APIFY_ACTOR`, `APIFY_INPUT_TEMPLATE`, `ELEVENLABS_MUSIC=off` (music beds via looped SFX generation instead of the music endpoint), `CARTESIA_MODEL`, `CARTESIA_VERSION`.

## What to check before the demo

- **Tested with mocked APIs only.** The pipeline ran end to end against fake Freesound/Apify/ElevenLabs responses (14 slots → 22 sounds, no duplicates, generation kicked in for slots with no results). It has not hit the real services yet; the first real run is the test.
- **Apify actor input.** Field names for the Mixkit actor (`searchQuery`, `mediaType`, `maxItems`) are a best guess. Open the actor's Input tab and fix them, or set `APIFY_INPUT_TEMPLATE`. Output fields are read defensively.
- **Cartesia request shape.** Check header names and `Cartesia-Version` against the TTS bytes docs.
- **Freesound rate limits.** Searches stop after 6 candidates per slot to stay under the per-minute cap; a 429 aborts that slot's search and falls through to generation.
- **Licensing.** CC-BY sounds store an attribution string; `library.forSession` returns them as `credits`. Show them somewhere (end card or settings). Freesound previews are what get stored, not originals (no OAuth needed).
- **The fallback planner is crude.** It turns every keyword into a "committed" SFX (so "abandoned house" becomes a search). With `ANTHROPIC_API_KEY` set, Claude skips non-sound keywords and classifies ambience as speculative.
- **Embeddings** are not computed here. The output phone embeds each sound's `label + tags` with all-MiniLM on load (~40 short strings, well under a second) and can cache them.

## Does Cartesia fit?

Not for this step's core job. Cartesia does speech (Sonic TTS, voice cloning, voice changer, Ink STT); it has no sound-effect or music generation, so it can't replace Freesound/ElevenLabs for SFX or music beds.

Where it does fit:

1. **Voice layer, pre-rendered (wired in).** Short lines like a whisper or "get out" are generated with Sonic TTS during the scrape and stored like any other sound, so they play from memory with no network at talk time.
2. **Speech-to-text (open question in the spec).** Ink-2 is a streaming STT with built-in turn detection and is pitched as a Deepgram Flux replacement. It now covers English, French, Hindi, Japanese and Spanish. The caution for Syncopation: it only emits words once it's confident (no revisable interim results). That makes transcripts cleaner but could add delay before the fast scorer sees a word, which the 250–350 ms budget depends on. Measure it with `bench/` (below) before switching.

## STT latency bench (`bench/`)

```bash
CARTESIA_API_KEY=sk_car_… node bench/server.mjs   # then open http://localhost:5174 in desktop Chrome
```

One mic feeds both Web Speech (interim results) and Cartesia Ink-2 (`/stt/turns/websocket`). Read the passage for about a minute, press Stop, and the page reports:
- **Same word, Cartesia minus Web Speech**: the number that matters for the fast scorer.
- First word after speech starts, and end of speech → final (plus Cartesia's eager end).
- How many interim words Web Speech revised (wrong words the scorer could have fired on).

The server mints a 5-minute access token so the key never reaches the browser. "Copy results" puts the raw timings on the clipboard.
3. **Live voice effects: probably not.** The voice changer takes a recorded file and returns converted audio, which doesn't fit a sub-second live effect on the speaker's mic. Tone.js effects (pitch shift, reverb, filters) on the output phone are the safer path.
