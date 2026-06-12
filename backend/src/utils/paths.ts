import path from 'path';
import fs from 'fs';

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
