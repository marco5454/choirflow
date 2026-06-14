# ChoirFlow

AI-assisted choir practice platform. **MVP scope:** upload SATB sheet music as
MusicXML (`.xml` / `.musicxml` / `.mxl`) **or PDF** and download four MP3
practice tracks — Soprano, Alto, Tenor, Bass.

PDF input is supported via [Audiveris](https://github.com/Audiveris/audiveris)
OMR. MusicXML uploads are recommended where possible (faster, more accurate);
PDF uploads run OMR first, which is slower and depends on scan quality.

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
- **Audiveris** *(optional — only required for PDF uploads)*. Default
  invocation path is `/opt/audiveris/bin/Audiveris`; override with the
  `AUDIVERIS_BIN` env var.

Install fluidsynth + ffmpeg on Debian / Ubuntu:

```bash
sudo apt-get install -y fluidsynth ffmpeg
```

Install fluidsynth + ffmpeg on macOS (Homebrew):

```bash
brew install fluid-synth ffmpeg
```

Audiveris is **not** packaged in the standard apt repositories. Grab the
latest `.deb` (Linux) or installer from the project's GitHub Releases page
and install manually:

<https://github.com/Audiveris/audiveris/releases>

```bash
# Example (Debian/Ubuntu, adjust the version to whatever release you grabbed)
sudo dpkg -i Audiveris-*.deb
```

If you only ever upload MusicXML files you can skip Audiveris entirely.

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

Open the frontend URL, drop a `.xml` / `.musicxml` / `.mxl` / `.pdf` file,
and wait for the four-voice MP3 players to appear.

## Tests

```bash
cd backend
npm test
```

(95 vitest cases covering MusicXML loading, SATB voice splitting, the job
queue, route handlers, middleware, and utilities.)

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

| Variable                       | Default                                                   | Purpose                                                  |
|--------------------------------|-----------------------------------------------------------|----------------------------------------------------------|
| `PORT`                         | `3000`                                                    | Express listen port                                      |
| `LOG_LEVEL`                    | `info` (`debug` in dev)                                   | pino log level                                           |
| `JOB_MAX_CONCURRENCY`          | `2`                                                       | Max pipeline jobs running in parallel                    |
| `JOB_CLEANUP_AFTER_MINUTES`    | `60`                                                      | Per-job artifact cleanup delay (`0` disables)            |
| `JOB_RETENTION_HOURS`          | `24`                                                      | Boot-time janitor sweep age                              |
| `UPLOAD_RATE_WINDOW_MINUTES`   | `15`                                                      | Upload rate-limit window                                 |
| `UPLOAD_RATE_MAX`              | `10`                                                      | Max uploads per IP per window                            |
| `SOUNDFONT_PATH`               | `backend/assets/soundfonts/GeneralUser-GS.sf2` (vendored) | SF2 used by fluidsynth                                   |
| `FLUIDSYNTH_BIN`               | `fluidsynth`                                              | fluidsynth executable name / path                        |
| `FFMPEG_BIN`                   | `ffmpeg`                                                  | ffmpeg executable name / path                            |
| `AUDIVERIS_BIN`                | `/opt/audiveris/bin/Audiveris`                            | Audiveris OMR executable (PDF uploads only)              |
| `AUDIVERIS_TIMEOUT_MS`         | `180000`                                                  | Hard timeout for a single Audiveris run                  |
| `RENDER_SAMPLE_RATE`           | `44100`                                                   | WAV sample rate                                          |
| `RENDER_MP3_QSCALE`            | `4`                                                       | libmp3lame VBR quality (0=best)                          |

---

## License

Project code: [MIT](./LICENSE) (also declared in both `backend/package.json`
and `frontend/package.json`).
GeneralUser GS soundfont: see `backend/assets/soundfonts/LICENSE-GeneralUser-GS.txt`.
