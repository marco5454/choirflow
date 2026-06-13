import path from 'path';
import fs from 'fs';
import { logger } from './logger';

/**
 * Storage layout (all under backend/storage):
 *   uploads/<jobId>.<ext>                       original upload
 *   work/<jobId>/{soprano,alto,tenor,bass}.mid  intermediate MIDIs
 *   output/<jobId>/{soprano,alto,tenor,bass}.mp3  final MP3s (later step)
 */

export const STORAGE_ROOT = path.resolve(__dirname, '..', '..', 'storage');
export const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
export const WORK_ROOT = path.join(STORAGE_ROOT, 'work');
export const OUTPUT_ROOT = path.join(STORAGE_ROOT, 'output');

export const VOICES = ['soprano', 'alto', 'tenor', 'bass'] as const;
export type Voice = (typeof VOICES)[number];

export function ensureBootDirs(): void {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
}

export function workDirFor(jobId: string): string {
  const dir = path.join(WORK_ROOT, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function outputDirFor(jobId: string): string {
  const dir = path.join(OUTPUT_ROOT, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function midiPathFor(jobId: string, voice: Voice): string {
  return path.join(workDirFor(jobId), `${voice}.mid`);
}

export function mp3PathFor(jobId: string, voice: Voice): string {
  return path.join(outputDirFor(jobId), `${voice}.mp3`);
}

/** Find the uploaded file for a jobId (we don't know the exact extension up front). */
export function findUploadFor(jobId: string): string | null {
  if (!fs.existsSync(UPLOADS_DIR)) return null;
  const entries = fs.readdirSync(UPLOADS_DIR);
  const match = entries.find((name) => name.startsWith(jobId + '.'));
  return match ? path.join(UPLOADS_DIR, match) : null;
}

/**
 * Best-effort sweep of upload/work/output entries older than `maxAgeMs`.
 * Called once at boot. Failures are logged and swallowed — we never want the
 * janitor to crash the server. Returns counts for logging.
 *
 * "Old enough" = mtime older than now - maxAgeMs. We deliberately don't
 * cross-reference with the in-memory job map: jobs only live in memory, so
 * after a restart there's no map to consult and mtime is the only signal.
 */
export interface SweepResult {
  uploads: number;
  workDirs: number;
  outputDirs: number;
}

export function sweepOldArtifacts(maxAgeMs: number): SweepResult {
  const cutoff = Date.now() - maxAgeMs;
  const result: SweepResult = { uploads: 0, workDirs: 0, outputDirs: 0 };

  // Files in UPLOADS_DIR (one file per job, named <jobId>.<ext>).
  if (fs.existsSync(UPLOADS_DIR)) {
    for (const name of fs.readdirSync(UPLOADS_DIR)) {
      const full = path.join(UPLOADS_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          result.uploads += 1;
        }
      } catch (err) {
        logger.warn({ path: full, err: (err as Error).message }, 'janitor: could not process upload');
      }
    }
  }

  // Subdirectories of WORK_ROOT and OUTPUT_ROOT (one dir per job).
  for (const [root, key] of [
    [WORK_ROOT, 'workDirs'],
    [OUTPUT_ROOT, 'outputDirs'],
  ] as const) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const full = path.join(root, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
          result[key] += 1;
        }
      } catch (err) {
        logger.warn({ path: full, err: (err as Error).message }, 'janitor: could not process directory');
      }
    }
  }

  return result;
}
