/**
 * End-to-end pipeline integration test.
 *
 * Drives the real `runPipeline()` against a fixture MusicXML file, exercising
 * the splitter and the actual fluidsynth + ffmpeg invocations. Every other
 * backend test mocks the worker; this is the only place the audio toolchain
 * is touched in CI-able form.
 *
 * Skipped automatically (with a clear reason) if fluidsynth, ffmpeg, or the
 * vendored soundfont aren't available locally, so it doesn't break runs on
 * machines without the audio toolchain.
 *
 * Not enabled in CI yet — CI has no audio binaries; enabling it requires
 * installing fluidsynth + ffmpeg in the workflow, which is a separate
 * decision.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Disable runtime cleanup so the worker's finally-block doesn't race our
// afterAll teardown. Must be set before any module reads the env.
vi.stubEnv('JOB_CLEANUP_AFTER_MINUTES', '0');

import { runPipeline } from '../../src/jobs/worker';
import { createJob, getJob, deleteJob } from '../../src/jobs/jobQueue';
import { _clearAllTimers } from '../../src/jobs/cleanup';
import {
  UPLOADS_DIR,
  WORK_ROOT,
  OUTPUT_ROOT,
  VOICES,
  ensureBootDirs,
  mp3PathFor,
} from '../../src/utils/paths';
import { getSoundfontPath } from '../../src/pipeline/renderAudio';

const execFileP = promisify(execFile);

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'satb-sample.xml');

/** Probe `which <bin>` without depending on shell builtins or PATH quirks. */
async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('which', [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Decide at module load whether the test toolchain is available. Computed
 * lazily inside beforeAll so we get a clear skip reason in test output.
 */
async function detectMissing(): Promise<string[]> {
  const missing: string[] = [];
  if (!(await which(process.env.FLUIDSYNTH_BIN ?? 'fluidsynth'))) missing.push('fluidsynth');
  if (!(await which(process.env.FFMPEG_BIN ?? 'ffmpeg'))) missing.push('ffmpeg');
  if (!fs.existsSync(getSoundfontPath())) missing.push(`soundfont (${getSoundfontPath()})`);
  return missing;
}

/**
 * MP3 magic-byte check. A real MP3 file from libmp3lame starts with either:
 *   - "ID3" (0x49 0x44 0x33)         — ID3v2 tag
 *   - 0xFF 0xFB / 0xFF 0xF3 / 0xFF 0xF2  — MPEG audio frame sync (no ID3 tag)
 *
 * Looser than parsing the frame, tighter than "size > 0".
 */
function looksLikeMp3(head: Buffer): boolean {
  if (head.length < 3) return false;
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true; // "ID3"
  if (head[0] === 0xff && (head[1] === 0xfb || head[1] === 0xf3 || head[1] === 0xf2)) return true;
  return false;
}

describe('pipeline integration: MusicXML -> 4 voice MP3s', () => {
  let missing: string[] = [];
  let jobId = '';

  beforeAll(async () => {
    missing = await detectMissing();
    if (missing.length > 0) return;

    ensureBootDirs();
    jobId = randomUUID();

    // Stage the fixture as if it had been uploaded: <UPLOADS_DIR>/<jobId>.xml.
    // runPipeline calls findUploadFor(jobId) which scans for that pattern.
    fs.copyFileSync(FIXTURE, path.join(UPLOADS_DIR, `${jobId}.xml`));

    // Register the job so updateJob() inside the worker has a target.
    createJob(jobId);
  });

  afterAll(() => {
    if (!jobId) return;

    // Best-effort artifact cleanup. The worker's scheduleCleanup is disabled
    // via JOB_CLEANUP_AFTER_MINUTES=0, but clear any stray timers anyway.
    _clearAllTimers();

    for (const f of fs.readdirSync(UPLOADS_DIR).filter((n) => n.startsWith(`${jobId}.`))) {
      fs.unlinkSync(path.join(UPLOADS_DIR, f));
    }
    fs.rmSync(path.join(WORK_ROOT, jobId), { recursive: true, force: true });
    fs.rmSync(path.join(OUTPUT_ROOT, jobId), { recursive: true, force: true });

    deleteJob(jobId);
  });

  it('produces 4 voice MP3s with valid headers', { timeout: 60_000 }, async (ctx) => {
    if (missing.length > 0) {
      ctx.skip(`audio toolchain not available: missing ${missing.join(', ')}`);
    }

    await runPipeline(jobId);

    const job = getJob(jobId);
    expect(job, 'job should still be registered').toBeDefined();
    expect(
      job?.status,
      `expected status=done, got ${job?.status} (error: ${job?.error ?? 'none'})`,
    ).toBe('done');

    for (const voice of VOICES) {
      const mp3 = mp3PathFor(jobId, voice);
      expect(fs.existsSync(mp3), `${voice}.mp3 should exist at ${mp3}`).toBe(true);

      const stat = fs.statSync(mp3);
      expect(stat.size, `${voice}.mp3 should be > 1024 bytes (got ${stat.size})`)
        .toBeGreaterThan(1024);

      const fd = fs.openSync(mp3, 'r');
      const head = Buffer.alloc(3);
      fs.readSync(fd, head, 0, 3, 0);
      fs.closeSync(fd);
      expect(
        looksLikeMp3(head),
        `${voice}.mp3 first 3 bytes [${[...head].map((b) => b.toString(16)).join(' ')}] should be ID3 or MPEG sync`,
      ).toBe(true);
    }
  });
});
