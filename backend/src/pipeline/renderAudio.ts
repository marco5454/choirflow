/**
 * MIDI → MP3 renderer.
 *
 * For a given job:
 *   1. fluidsynth renders each voice's .mid to a temporary WAV (4 calls).
 *   2. For each voice, ffmpeg mixes all 4 WAVs into one MP3 with that voice
 *      prominent and the other three at a background level (1 call per
 *      output).
 *   3. The 4 intermediate WAVs are deleted.
 *
 * So soprano.mp3 contains all 4 voices, with soprano loud and ATB soft —
 * the standard choir-practice-track convention. A singer can rehearse their
 * line with full harmonic context.
 *
 * Both tools are invoked via execFile (no shell, no string interpolation =
 * no quoting issues, no shell injection).
 *
 * Configurable via env:
 *   SOUNDFONT_PATH       default: <repo>/backend/assets/soundfonts/GeneralUser-GS.sf2
 *   FLUIDSYNTH_BIN       default: fluidsynth
 *   FFMPEG_BIN           default: ffmpeg
 *   RENDER_SAMPLE_RATE   default: 44100
 *   RENDER_MP3_QSCALE    default: 4    (libmp3lame VBR; 0=best, 9=worst)
 *   MIX_PROMINENT_DB     default: -3   (dB applied to the prominent voice)
 *   MIX_BACKGROUND_DB    default: -15  (dB applied to each of the other 3)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import type { Voice } from '../utils/paths';
import { midiPathFor, mp3PathFor, outputDirFor, VOICES } from '../utils/paths';

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
const MIX_PROMINENT_DB = Number(process.env.MIX_PROMINENT_DB ?? -3);
const MIX_BACKGROUND_DB = Number(process.env.MIX_BACKGROUND_DB ?? -15);

export interface RenderResult {
  mp3Paths: Record<Voice, string>;
}

export function getSoundfontPath(): string {
  return SOUNDFONT_PATH;
}

async function renderVoiceToWav(jobId: string, voice: Voice): Promise<string> {
  const midiPath = midiPathFor(jobId, voice);
  if (!fs.existsSync(midiPath)) {
    throw new Error(`MIDI not found for ${voice}: ${midiPath}`);
  }

  const wavPath = path.join(outputDirFor(jobId), `${voice}.wav`);

  // fluidsynth flags:
  //   -ni  : non-interactive (no shell prompt)
  //   -F   : output file
  //   -r   : sample rate
  //   -g 1 : explicit gain so volumes match across runs
  await execFileP(
    FLUIDSYNTH_BIN,
    ['-ni', '-F', wavPath, '-r', String(SAMPLE_RATE), '-g', '1', SOUNDFONT_PATH, midiPath],
    { timeout: 60_000 },
  );

  if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size === 0) {
    throw new Error(`fluidsynth produced no audio for ${voice}`);
  }

  return wavPath;
}

/**
 * Mix four voice WAVs into one MP3 with `prominent` loud and the rest soft.
 *
 * The filter graph:
 *   [0:a]volume=Pdb[a0];
 *   [1:a]volume=Bdb[a1];
 *   [2:a]volume=Bdb[a2];
 *   [3:a]volume=Bdb[a3];
 *   [a0][a1][a2][a3]amix=inputs=4:normalize=0,alimiter=limit=0.95[aout]
 *
 *   - `volume` per input applies our prominent / background dB levels.
 *   - `amix=normalize=0` sums the inputs as-is instead of dividing by N
 *     (we set absolute levels via `volume`, so we don't want amix to halve them).
 *   - `alimiter=limit=0.95` is a brick-wall safety net: with prominent at -3 dB
 *     and three backgrounds at -15 dB, the worst-case sample sum is
 *     0.708 + 3*0.178 ≈ 1.24, which would clip without the limiter. With it,
 *     occasional peaks are caught at -0.45 dBFS without affecting the rest.
 */
async function mixToMp3(
  jobId: string,
  prominent: Voice,
  wavByVoice: Record<Voice, string>,
): Promise<string> {
  const mp3Path = mp3PathFor(jobId, prominent);

  // Inputs in a stable order (VOICES) so [0:a]..[3:a] map to known voices.
  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  const labels: string[] = [];
  VOICES.forEach((v, i) => {
    inputArgs.push('-i', wavByVoice[v]);
    const db = v === prominent ? MIX_PROMINENT_DB : MIX_BACKGROUND_DB;
    const label = `a${i}`;
    filterParts.push(`[${i}:a]volume=${db}dB[${label}]`);
    labels.push(`[${label}]`);
  });
  const filterComplex =
    filterParts.join(';') +
    ';' +
    labels.join('') +
    'amix=inputs=4:normalize=0,alimiter=limit=0.95[aout]';

  await execFileP(
    FFMPEG_BIN,
    [
      '-y',
      '-loglevel',
      'error',
      ...inputArgs,
      '-filter_complex',
      filterComplex,
      '-map',
      '[aout]',
      '-codec:a',
      'libmp3lame',
      '-q:a',
      MP3_QSCALE,
      mp3Path,
    ],
    { timeout: 60_000 },
  );

  if (!fs.existsSync(mp3Path) || fs.statSync(mp3Path).size === 0) {
    throw new Error(`ffmpeg produced no MP3 for ${prominent}`);
  }

  return mp3Path;
}

export async function renderAudio(jobId: string): Promise<RenderResult> {
  // Phase 1: render each voice MIDI → WAV. Serial to avoid CPU thrash on
  // single-core hosts; renders are fast (<2s/voice for short pieces).
  const wavByVoice = {} as Record<Voice, string>;
  try {
    for (const voice of VOICES) {
      wavByVoice[voice] = await renderVoiceToWav(jobId, voice);
    }

    // Phase 2: produce 4 mixes, one per prominent voice.
    const mp3Paths = {} as Record<Voice, string>;
    for (const voice of VOICES) {
      mp3Paths[voice] = await mixToMp3(jobId, voice, wavByVoice);
    }

    return { mp3Paths };
  } finally {
    // Phase 3: drop intermediate WAVs whether or not we succeeded. We only
    // unlink files we actually created (Object.values may include undefined
    // if we failed mid-loop in phase 1).
    await Promise.all(
      Object.values(wavByVoice)
        .filter((p): p is string => typeof p === 'string')
        .map((p) => fs.promises.unlink(p).catch(() => undefined)),
    );
  }
}
