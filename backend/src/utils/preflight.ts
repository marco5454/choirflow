/**
 * Boot-time check for the external dependencies the audio pipeline needs.
 * Logs warnings (does not exit) so dev can still hit /health and /upload
 * for MusicXML inspection even without audio render available.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import { getSoundfontPath } from '../pipeline/renderAudio';

function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('which', [bin], (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim() || null);
    });
  });
}

export async function preflight(): Promise<void> {
  const fluid = await which(process.env.FLUIDSYNTH_BIN ?? 'fluidsynth');
  const ffmpeg = await which(process.env.FFMPEG_BIN ?? 'ffmpeg');
  const soundfontPath = getSoundfontPath();
  const sfExists = fs.existsSync(soundfontPath);

  console.log('[preflight] fluidsynth:', fluid ?? 'NOT FOUND');
  console.log('[preflight] ffmpeg:    ', ffmpeg ?? 'NOT FOUND');
  console.log('[preflight] soundfont: ', soundfontPath, sfExists ? '(ok)' : '(MISSING)');

  if (!fluid || !ffmpeg) {
    console.warn(
      '[preflight] WARNING: audio render binaries missing. ' +
        'Jobs will fail at the rendering stage. ' +
        'Install: sudo apt-get install -y fluidsynth ffmpeg',
    );
  }
  if (!sfExists) {
    console.warn(
      `[preflight] WARNING: soundfont not found at ${soundfontPath}. ` +
        'The vendored GeneralUser-GS.sf2 should live at backend/assets/soundfonts/. ' +
        'Re-clone the repo, or set SOUNDFONT_PATH to a valid .sf2 file.',
    );
  }
}
