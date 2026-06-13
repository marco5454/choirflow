/**
 * Boot-time check for the external dependencies the audio pipeline needs.
 * Logs warnings (does not exit) so dev can still hit /health and /upload
 * for MusicXML inspection even without audio render available.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import { getSoundfontPath } from '../pipeline/renderAudio';
import { getAudiverisBin } from '../pipeline/runOmr';
import { logger } from './logger';

function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('which', [bin], (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim() || null);
    });
  });
}

/**
 * Resolve a binary that may be either on PATH or specified as an absolute path.
 * Returns the absolute path if it exists, else null.
 */
async function resolveBinary(bin: string): Promise<string | null> {
  if (bin.startsWith('/') || bin.startsWith('./') || bin.startsWith('../')) {
    return fs.existsSync(bin) ? bin : null;
  }
  return which(bin);
}

export async function preflight(): Promise<void> {
  const fluid = await resolveBinary(process.env.FLUIDSYNTH_BIN ?? 'fluidsynth');
  const ffmpeg = await resolveBinary(process.env.FFMPEG_BIN ?? 'ffmpeg');
  const audiveris = await resolveBinary(getAudiverisBin());
  const soundfontPath = getSoundfontPath();
  const sfExists = fs.existsSync(soundfontPath);

  logger.info(
    {
      fluidsynth: fluid ?? null,
      ffmpeg: ffmpeg ?? null,
      audiveris: audiveris ?? null,
      audiverisBin: getAudiverisBin(),
      soundfont: soundfontPath,
      soundfontExists: sfExists,
    },
    'preflight: external dependency check',
  );

  if (!fluid || !ffmpeg) {
    logger.warn(
      'preflight: audio render binaries missing. Jobs will fail at the rendering stage. ' +
        'Install: sudo apt-get install -y fluidsynth ffmpeg',
    );
  }
  if (!audiveris) {
    logger.warn(
      'preflight: Audiveris not found. PDF uploads will fail at the OMR stage ' +
        '(MusicXML uploads are unaffected). Install from ' +
        'https://github.com/Audiveris/audiveris/releases or set AUDIVERIS_BIN.',
    );
  }
  if (!sfExists) {
    logger.warn(
      { soundfontPath },
      'preflight: soundfont not found. The vendored GeneralUser-GS.sf2 should live at ' +
        'backend/assets/soundfonts/. Re-clone the repo, or set SOUNDFONT_PATH.',
    );
  }
}
