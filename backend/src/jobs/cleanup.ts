/**
 * Per-job runtime cleanup.
 *
 * When a job reaches a terminal state (`done` or `failed`), the worker
 * schedules cleanup after a configurable delay. Cleanup deletes the
 * upload file, work directory, output directory, and removes the job
 * from the in-memory queue.
 *
 * The boot-time `sweepOldArtifacts` in `utils/paths.ts` remains as a
 * safety net for stuff that escaped runtime cleanup (server killed
 * mid-job, etc.).
 *
 * All filesystem operations are best-effort: missing files/dirs are
 * silently ignored, and unexpected errors are logged but never thrown.
 */

import fs from 'fs';
import path from 'path';
import { WORK_ROOT, OUTPUT_ROOT, findUploadFor } from '../utils/paths';
import { deleteJob } from './jobQueue';
import { logger } from '../utils/logger';

const timers = new Map<string, NodeJS.Timeout>();

/**
 * Read the configured cleanup delay from the environment. Default 60 minutes.
 * Set `JOB_CLEANUP_AFTER_MINUTES=0` (or negative) to disable runtime cleanup
 * and rely solely on the boot-time janitor.
 */
export function getCleanupDelayMs(): number {
  const raw = process.env.JOB_CLEANUP_AFTER_MINUTES;
  const minutes = raw === undefined ? 60 : Number(raw);
  if (!Number.isFinite(minutes)) return 60 * 60 * 1000;
  return Math.max(0, minutes) * 60 * 1000;
}

/**
 * Schedule cleanup for a job after `delayMs`. If a timer already exists
 * for the same jobId, it is replaced (defensive — runPipeline should
 * only run once per job, but this keeps the API robust).
 *
 * Pass delayMs <= 0 to skip scheduling entirely (useful for tests or
 * to disable runtime cleanup via env config).
 */
export function scheduleCleanup(jobId: string, delayMs: number): void {
  if (delayMs <= 0) return;

  const existing = timers.get(jobId);
  if (existing) {
    clearTimeout(existing);
  }

  const handle = setTimeout(() => {
    timers.delete(jobId);
    runCleanupNow(jobId);
  }, delayMs);

  // Don't keep the event loop alive solely for cleanup.
  handle.unref?.();
  timers.set(jobId, handle);
}

/**
 * Cancel a scheduled cleanup, if any. Returns true if a timer was cancelled.
 * Currently only used by tests; exported for completeness.
 */
export function cancelCleanup(jobId: string): boolean {
  const t = timers.get(jobId);
  if (!t) return false;
  clearTimeout(t);
  timers.delete(jobId);
  return true;
}

/**
 * Immediately delete all artifacts for a job and remove it from the queue.
 * Idempotent — safe to call multiple times or on jobs that never had files.
 */
export function runCleanupNow(jobId: string): void {
  // Upload file (single file with unknown extension).
  const uploadPath = findUploadFor(jobId);
  if (uploadPath) {
    try {
      fs.unlinkSync(uploadPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        logger.warn({ jobId, path: uploadPath, err: e.message }, 'cleanup: failed to delete upload');
      }
    }
  }

  // Work and output directories.
  for (const root of [WORK_ROOT, OUTPUT_ROOT]) {
    const dir = path.join(root, jobId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ jobId, dir, err: (err as Error).message }, 'cleanup: failed to remove directory');
    }
  }

  // Remove from in-memory queue.
  deleteJob(jobId);
}

/** Test-only: number of currently scheduled timers. */
export function _scheduledCount(): number {
  return timers.size;
}

/** Test-only: clear all pending timers without firing them. */
export function _clearAllTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
