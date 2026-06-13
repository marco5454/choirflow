/**
 * MIDI → MP3 renderer.
 *
 * For each voice's .mid in work/<jobId>/:
 *   1. fluidsynth → WAV (in tmp inside work dir)
 *   2. ffmpeg     → MP3 in output/<jobId>/
 *   3. delete the WAV
 *
 * Both tools are invoked via execFile (no shell, no string interpolation =
 * no quoting issues, no shell injection).
 *
 * Configurable via env:
 *   SOUNDFONT_PATH  default: <repo>/backend/assets/soundfonts/GeneralUser-GS.sf2
 *   FLUIDSYNTH_BIN  default: fluidsynth
 *   FFMPEG_BIN      default: ffmpeg
 *   RENDER_SAMPLE_RATE  default: 44100
 *   RENDER_MP3_QSCALE   default: 4   (libmp3lame VBR; 0=best, 9=worst)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { midiPathFor, mp3PathFor, outputDirFor, VOICES, Voice } from '../utils/paths';

const execFileP = promisify(execFile);

// Vendored under backend/assets/soundfonts/ (committed to the repo, ~30 MB).
// At runtime __dirname is either backend/src/pipeline (ts-node dev) or
// backend/dist/pipeline (built). The vendored asset stays under backend/assets/
// in BOTH cases (we don't copy it into dist/). Resolve by trying the dev
// layout first, then the built layout.
function resolveDefaultSoundfontPath(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'assets', 'soundfonts', 'GeneralUser-GS.sf2'), // dev: src/pipeline → backend/
    path.resolve(__dirname, '..', '..', '..', 'assets', 'soundfonts', 'GeneralUser-GS.sf2'), // built: dist/pipeline → backend/
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Neither exists; return the dev-layout candidate so error messages are predictable.
  return candidates[0];
}

const SOUNDFONT_PATH = process.env.SOUNDFONT_PATH ?? resolveDefaultSoundfontPath();
const FLUIDSYNTH_BIN = process.env.FLUIDSYNTH_BIN ?? 'fluidsynth';
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? 'ffmpeg';
const SAMPLE_RATE = Number(process.env.RENDER_SAMPLE_RATE ?? 44100);
const MP3_QSCALE = String(process.env.RENDER_MP3_QSCALE ?? '4');

export interface RenderResult {
  mp3Paths: Record<Voice, string>;
}

export function getSoundfontPath(): string {
  return SOUNDFONT_PATH;
}

async function renderOneVoice(jobId: string, voice: Voice): Promise<string> {
  const midiPath = midiPathFor(jobId, voice);
  if (!fs.existsSync(midiPath)) {
    throw new Error(`MIDI not found for ${voice}: ${midiPath}`);
  }

  const wavPath = path.join(outputDirFor(jobId), `${voice}.wav`);
  const mp3Path = mp3PathFor(jobId, voice);

  // 1. MIDI → WAV
  //   -ni  : no shell / no interactive
  //   -F   : output file
  //   -r   : sample rate
  //   -g 1 : gain (default is fine, but make explicit so volumes match across runs)
  await execFileP(
    FLUIDSYNTH_BIN,
    ['-ni', '-F', wavPath, '-r', String(SAMPLE_RATE), '-g', '1', SOUNDFONT_PATH, midiPath],
    { timeout: 60_000 },
  );

  if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size === 0) {
    throw new Error(`fluidsynth produced no audio for ${voice}`);
  }

  // 2. WAV → MP3 (VBR, libmp3lame)
  await execFileP(
    FFMPEG_BIN,
    ['-y', '-loglevel', 'error', '-i', wavPath, '-codec:a', 'libmp3lame', '-q:a', MP3_QSCALE, mp3Path],
    { timeout: 60_000 },
  );

  if (!fs.existsSync(mp3Path) || fs.statSync(mp3Path).size === 0) {
    throw new Error(`ffmpeg produced no MP3 for ${voice}`);
  }

  // 3. Drop the intermediate WAV
  await fs.promises.unlink(wavPath).catch(() => undefined);

  return mp3Path;
}

export async function renderAudio(jobId: string): Promise<RenderResult> {
  const mp3Paths = {} as Record<Voice, string>;
  // Render serially. Could parallelize, but on a single CPU we'd just thrash; the
  // numbers are small (<2s per voice for short pieces) so keep it simple.
  for (const voice of VOICES) {
    mp3Paths[voice] = await renderOneVoice(jobId, voice);
  }
  return { mp3Paths };
}
