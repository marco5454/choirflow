# ChoirFlow

AI-assisted choir practice platform. **MVP scope:** upload SATB sheet music in
MusicXML form (`.xml` / `.musicxml` / `.mxl`) and download four MP3 practice
tracks — Soprano, Alto, Tenor, Bass.

PDF input via OMR (Audiveris) is on the roadmap but **not** part of the current
pipeline; please convert PDFs to MusicXML upstream (e.g. with MuseScore) for now.

---

## Repository layout

```
choirflow/
├── backend/    Node.js + Express + TypeScript pipeline
└── frontend/   React + Vite + TypeScript + Tailwind UI
```

The pipeline runs entirely on local disk (`backend/storage/`) and an in-memory
job queue. State is intentionally lost on restart — fine for MVP development.

---

## Prerequisites

- **Node.js ≥ 20**
- **fluidsynth** and **ffmpeg** on `PATH` (the audio render shells out to
  both)

Install on Debian / Ubuntu:

```bash
sudo apt-get install -y fluidsynth ffmpeg
```

Install on macOS (Homebrew):

```bash
brew install fluid-synth ffmpeg
```

The soundfont is **vendored in this repo** — no separate install required
(see [Soundfont](#soundfont) below).

---

## Setup

```bash
# Backend
cd backend
npm install

# Frontend (separate terminal)
cd frontend
npm install
```

## Run (development)

```bash
# Backend  (http://localhost:3000)
cd backend
npm run dev

# Frontend (http://localhost:5173, proxies API calls to :3000)
cd frontend
npm run dev
```

Open the frontend URL, drop a `.xml` / `.musicxml` / `.mxl` file, and wait
for the four-voice MP3 players to appear.

## Tests

```bash
cd backend
npm test
```

(18 vitest cases covering MusicXML loading and SATB voice splitting.)

## Build (production-ish)

```bash
cd backend && npm run build && npm start
cd frontend && npm run build && npm run preview
```

---

## Soundfont

The audio renderer uses **GeneralUser GS v2.0.3** by S. Christian Collins,
vendored at:

```
backend/assets/soundfonts/GeneralUser-GS.sf2          (~30 MB)
backend/assets/soundfonts/LICENSE-GeneralUser-GS.txt
```

GeneralUser GS is freely redistributable (including for commercial use); the
full license text accompanies the file. Upstream:
<https://www.schristiancollins.com/generaluser> /
<https://github.com/mrbumpy409/GeneralUser-GS>.

To swap soundfonts, set the `SOUNDFONT_PATH` env var to any other `.sf2` file
before launching the backend.

---

## Backend environment variables

All optional; sensible defaults in code.

| Variable               | Default                                                   | Purpose                            |
|------------------------|-----------------------------------------------------------|------------------------------------|
| `PORT`                 | `3000`                                                    | Express listen port                |
| `JOB_RETENTION_HOURS`  | `24`                                                      | Boot-time janitor sweep age        |
| `SOUNDFONT_PATH`       | `backend/assets/soundfonts/GeneralUser-GS.sf2` (vendored) | SF2 used by fluidsynth             |
| `FLUIDSYNTH_BIN`       | `fluidsynth`                                              | fluidsynth executable name / path  |
| `FFMPEG_BIN`           | `ffmpeg`                                                  | ffmpeg executable name / path      |
| `RENDER_SAMPLE_RATE`   | `44100`                                                   | WAV sample rate                    |
| `RENDER_MP3_QSCALE`    | `4`                                                       | libmp3lame VBR quality (0=best)    |

---

## License

Project code: not yet licensed (TBD).
GeneralUser GS soundfont: see `backend/assets/soundfonts/LICENSE-GeneralUser-GS.txt`.
