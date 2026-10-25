# Syncopation

**Syncopation** is a real-time, AI-powered live soundtrack and sound-design engine for human speech. As a speaker talks, the system continuously analyzes narrative arc, predicts future story beats, dynamically fetches audio assets, and performs low-latency sound synthesis and DJ-grade audio mixing—generating reactive music beds, ambient environments, and synchronous sound effects beneath the live voice.

---

## The Core Technical Challenge: The Latency Paradox

In live performance or speech enhancement, **timing is everything**. If a speaker says *"and then the gunshot fired"* or *"I heard a faint creak"*, a sound effect that lands 2 seconds late breaks the illusion and destroys comedic or dramatic timing.

* **Standard LLM Reasoning Latency:** Evaluating rich narrative context, story state, and sound selection through an LLM requires **1,200 ms to 3,100 ms**.
* **Human Auditory Perception Threshold:** An acoustic sound effect must trigger within **< 50 ms** of the spoken trigger word to feel perceptually instantaneous and locked to the speaker.

Waiting for an LLM to decide on every word creates an unusable lag. Syncopation solves this with a **Decoupled Dual-Loop Architecture** featuring a **5-step forward anticipation horizon** and a **sub-20ms instant decision engine**.

---

## System Architecture

```
                                  [ Live Microphone Audio ]
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
             [ Streaming STT ]                           [ PCM Master Mixer ]
         Deepgram Nova-3 (WebSocket)                    In-Process 44.1 kHz Stream
       • Dynamic Keyterm Biasing                        • Downbeat Alignment
       • 300ms Endpointing                              • Lookahead Dynamic Ducking
                       │                                • Tanh Soft Limiter
                       ▼                                           ▲
      ┌────────────────────────────────────────────────────────┐   │
      │              DUAL-LOOP DECISION ENGINE                 │   │
      │                                                        │   │
      │   FAST LOOP (Sub-20ms)      BACKGROUND LOOP (~2s)      │   │
      │   Online Logistic Regr.     Claude 3.5 / Haiku         │   │
      │   • Word Stemming & Roots   • 5-Step Forward Horizon   │   │
      │   • 9-Dim Feature Vector    • Narrative Arc & Tension  │   │
      │   • Online SGD Learning     • Live Director & Scraping │   │
      │          ▲                               │             │   │
      │          └────── [ Anticipation Pool ] ──┘             │   │
      └────────────────────────────┬───────────────────────────┘   │
                                   ▼                               │
                      [ Psychoacoustic Treatment ] ────────────────┘
                      Metadata (Softness/Intensity/Attack)
                      + DSP Profiling (Impulse/Crest Factor)
```

---

## Key Technical Innovations

### 1. 5-Step Forward Anticipation Horizon (`[index+1] … [index+5]`)
Instead of reacting in hindsight to what was just spoken, the background LLM operates as an **Anticipatory Story Engine**:
* Every sentence, Claude analyzes the story-so-far, evaluates narrative momentum, and projects **1 to 5 narrative beats into the future**.
* For each future slot, it estimates potential sound triggers, likelihood scores, and expected narrative actions.
* These projections populate a rolling **Anticipation Pool** equipped with temporal decay functions:
  $$\text{Prior}(sound) = \text{Score} \times \text{Decay}_{\text{age}} \times \text{Decay}_{\text{offset}}$$
* When the speaker's words arrive at that point in the talk, the fast loop doesn't have to think—it already has the sounds primed and waiting.

### 2. Sub-20ms Frontend Decision Loop (Online Logistic Regression)
* While the LLM plans the future in the background, a lightweight deterministic model evaluates streaming speech in **under 20 ms**.
* **Instant Probability Score:**
  $$P(\text{play}) = \sigma(\mathbf{w}^T \mathbf{x})$$
* **9-Dimensional Feature Vector ($\mathbf{x}$):**
  1. `bias`: Baseline firing propensity (bounded to prevent silence or over-triggering).
  2. `claude`: Anticipation weight pulled from the 5-step pool.
  3. `words`: Stemmed lexical match with irregular past-tense normalization (`rang` $\to$ `ring`, `slammed` $\to$ `slam`).
  4. `keyword`: Matches against active setup and live story keywords.
  5. `tension fit`: Congruence between track tension and current speech intensity.
  6. `on-topic`: Semantic alignment with the story core.
  7. `repeat`: Exponential penalty against recent activations.
  8. `need`: Dynamic narrative appetite for auditory punctuation.
  9. `context fit`: Historical scene coherence.
* **Online Stochastic Gradient Descent:** After every utterance, Claude provides a hindsight judgment of what *should* have played. The fast loop calculates the loss and immediately updates $\mathbf{w}$ via SGD, persisting learned weights across sessions in `weights.json`.

### 3. Dynamic Keyterm Biasing for Streaming STT (`stt.ts`)
* High-speed speech-to-text is powered by a direct PCM WebSocket pipeline into **Deepgram Nova-3** (`endpointing=300ms`).
* **Trigger Phrase Injection:** The sound library's trigger terms and onomatopoeia (`creak`, `slam`, `footsteps`, `applause`) are dynamically injected as keyterm biases into the active STT session. This ensures critical sound triggers are recognized accurately on the first syllable before the word finishes.

### 4. Global Story & Context Monitor ("The Whole Picture")
The system maintains global narrative state rather than treating sound cues as isolated one-shots:
* **Narrative Arc Tracking:** Tracks story progression through explicit stages (`setup` $\to$ `rising` $\to$ `climax` $\to$ `resolution`).
* **Continuous Tension Curve:** A normalized tension scalar ($0.0 \dots 1.0$) guides dynamic music switches, ambience density, and stinger eligibility.
* **Live AI Director & Asset Scraping:** If a speaker deviates from the original prompt into unexpected territory, a background Live Director evaluates the transcript against the active audio library, automatically searching and ingesting missing sound effects in parallel from Freesound and ElevenLabs.

### 5. DJ-Grade Mix Monitor & Psychoacoustic Soundstaging (`player.ts`)
Raw audio clips are never played unprocessed over speech. Every sound passes through an in-process 44.1 kHz PCM mixing engine:
* **Harmonic Mixing & Beat Sync:** Analyzes BPM, beat phase, and key (Camelot wheel). Musical bed transitions are executed as equal-power crossfades scheduled precisely on downbeat/bar boundaries ($\le 4\text{ s}$).
* **Predictive Lookahead Ducking:** When a high-impact sound effect is triggered, background music and ambience duck ($-5\text{ dB}$ to $-9\text{ dB}$) with brief lookahead, clearing acoustic space for the transient hit before smoothly recovering.
* **Acoustic Profiling & Dynamic EQ:** Measures impulse crest factors, rise times, and zero-crossing rates on raw PCM. Soft or atmospheric cues receive lowpass filtering and tailored attack/release envelopes so they mesh with the room rather than sounding like disconnected soundboard samples.
* **Tanh Soft Limiter:** Average RMS level targeting combined with hyperbolic tangent saturation ($a > 0.7 \implies \tanh$) preserves clarity and perceived punch on laptop speakers without harsh digital clipping.

---

## Getting Started

### Prerequisites

* **Node.js** (v20+ recommended)
* **sox** and **ffmpeg** (for microphone recording and audio decoding)

On macOS:
```bash
brew install sox ffmpeg
```

### Installation

```bash
git clone https://github.com/Aimee251/Syncopation.git
cd Syncopation
npm install
```

Configure your `.env` file with the required API keys:
```env
ANTHROPIC_API_KEY=your_anthropic_key
DEEPGRAM_API_KEY=your_deepgram_key
FREESOUND_API_KEY=your_freesound_key
ELEVENLABS_API_KEY=your_elevenlabs_key   # Optional (fallback generation)
```

### Running the Application

#### Web Experience (Full Stack)
```bash
npm run app            # Backend on :8787 + Web app on :5173
```
* Open `http://localhost:5173` in Chrome or Safari.
* Press and hold to speak your theme $\to$ sound library generates $\to$ start speaking under the live adaptive score!

Additional options:
```bash
npm run app -- --mic "Shure MV7"   # Select a specific input microphone
npm run app -- --phone            # Serve over HTTPS for mobile testing on local Wi-Fi
```

#### Terminal-Only Mode
```bash
npm run dev
```
Run with typed inputs or live mic streaming directly in the command line interface.
