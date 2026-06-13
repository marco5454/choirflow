/**
 * Tests for jobs/cleanup.ts.
 *
 * - runCleanupNow: deletes upload, work dir, output dir, removes job from queue, idempotent.
 * - scheduleCleanup: fires after delay (fake timers); no-op when delay <= 0; reschedule cancels previous timer.
 * - getCleanupDelayMs: reads env, defaults, handles bad input.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  scheduleCleanup,
  runCleanupNow,
  getCleanupDelayMs,
  cancelCleanup,
  _scheduledCount,
  _clearAllTimers,
} from '../../src/jobs/cleanup';
import { createJob, getJob } from '../../src/jobs/jobQueue';
import {
  UPLOADS_DIR,
  WORK_ROOT,
  OUTPUT_ROOT,
  workDirFor,
  outputDirFor,
} from '../../src/utils/paths';

const createdJobIds = new Set<string>();

function jobId(suffix: string): string {
  const id = `test-cleanup-${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdJobIds.add(id);
  return id;
}

/** Plant the full set of artifacts for a jobId so we can assert all three are removed. */
function plantArtifacts(id: string): { upload: string; workDir: string; outputDir: string } {
  const upload = path.join(UPLOADS_DIR, `${id}.musicxml`);
  fs.writeFileSync(upload, 'fake-input');
  const workDir = workDirFor(id); // creates dir
  fs.writeFileSync(path.join(workDir, 'soprano.mid'), 'fake-mid');
  const outputDir = outputDirFor(id); // creates dir
  fs.writeFileSync(path.join(outputDir, 'soprano.mp3'), 'fake-mp3');
  return { upload, workDir, outputDir };
}

afterEach(() => {
  _clearAllTimers();
  // Belt and braces: scrub any leftover artifacts in case a test bailed early.
  for (const id of createdJobIds) {
    try {
      const upload = path.join(UPLOADS_DIR, `${id}.musicxml`);
      if (fs.existsSync(upload)) fs.unlinkSync(upload);
      fs.rmSync(path.join(WORK_ROOT, id), { recursive: true, force: true });
      fs.rmSync(path.join(OUTPUT_ROOT, id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  createdJobIds.clear();
});

describe('runCleanupNow', () => {
  it('deletes upload file, work dir, output dir, and removes job from queue', () => {
    const id = jobId('full');
    createJob(id);
    const { upload, workDir, outputDir } = plantArtifacts(id);

    expect(fs.existsSync(upload)).toBe(true);
    expect(fs.existsSync(workDir)).toBe(true);
    expect(fs.existsSync(outputDir)).toBe(true);
    expect(getJob(id)).toBeDefined();

    runCleanupNow(id);

    expect(fs.existsSync(upload)).toBe(false);
    expect(fs.existsSync(workDir)).toBe(false);
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(getJob(id)).toBeUndefined();
  });

  it('is idempotent: calling twice does not throw and leaves the job gone', () => {
    const id = jobId('idem');
    createJob(id);
    plantArtifacts(id);

    runCleanupNow(id);
    expect(() => runCleanupNow(id)).not.toThrow();
    expect(getJob(id)).toBeUndefined();
  });

  it('handles a job that never produced any artifacts', () => {
    const id = jobId('no-files');
    createJob(id);

    expect(() => runCleanupNow(id)).not.toThrow();
    expect(getJob(id)).toBeUndefined();
  });

  it('handles a jobId that was never registered', () => {
    const id = jobId('phantom');
    // Do not call createJob; do not plant files.
    expect(() => runCleanupNow(id)).not.toThrow();
    expect(getJob(id)).toBeUndefined();
  });
});

describe('scheduleCleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when delayMs <= 0', () => {
    const id = jobId('no-delay');
    createJob(id);
    plantArtifacts(id);

    scheduleCleanup(id, 0);
    scheduleCleanup(id, -1);

    expect(_scheduledCount()).toBe(0);
    expect(getJob(id)).toBeDefined();
  });

  it('fires runCleanupNow after the delay', () => {
    const id = jobId('fires');
    createJob(id);
    const { upload, workDir, outputDir } = plantArtifacts(id);

    scheduleCleanup(id, 1000);
    expect(_scheduledCount()).toBe(1);

    // Just before the deadline: still scheduled, files intact.
    vi.advanceTimersByTime(999);
    expect(fs.existsSync(upload)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(fs.existsSync(upload)).toBe(false);
    expect(fs.existsSync(workDir)).toBe(false);
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(getJob(id)).toBeUndefined();
    expect(_scheduledCount()).toBe(0);
  });

  it('rescheduling the same jobId cancels the previous timer (cleanup runs once)', () => {
    const id = jobId('reschedule');
    createJob(id);
    const { upload } = plantArtifacts(id);

    scheduleCleanup(id, 5000);
    expect(_scheduledCount()).toBe(1);

    // Advance partway, then reschedule with a longer delay.
    vi.advanceTimersByTime(2000);
    scheduleCleanup(id, 5000);
    expect(_scheduledCount()).toBe(1);

    // Original 5000ms total has passed (2000 + 3000), but rescheduling
    // reset the clock — file should still exist.
    vi.advanceTimersByTime(3000);
    expect(fs.existsSync(upload)).toBe(true);

    // Now wait the remaining 2000ms of the new schedule.
    vi.advanceTimersByTime(2000);
    expect(fs.existsSync(upload)).toBe(false);
  });

  it('cancelCleanup removes a pending timer without firing it', () => {
    const id = jobId('cancel');
    createJob(id);
    const { upload } = plantArtifacts(id);

    scheduleCleanup(id, 1000);
    expect(cancelCleanup(id)).toBe(true);
    expect(_scheduledCount()).toBe(0);

    vi.advanceTimersByTime(5000);
    expect(fs.existsSync(upload)).toBe(true);
    expect(getJob(id)).toBeDefined();

    // Calling cancelCleanup again returns false.
    expect(cancelCleanup(id)).toBe(false);
  });
});

describe('getCleanupDelayMs', () => {
  const ORIGINAL = process.env.JOB_CLEANUP_AFTER_MINUTES;
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.JOB_CLEANUP_AFTER_MINUTES;
    } else {
      process.env.JOB_CLEANUP_AFTER_MINUTES = ORIGINAL;
    }
  });

  it('defaults to 60 minutes when env not set', () => {
    delete process.env.JOB_CLEANUP_AFTER_MINUTES;
    expect(getCleanupDelayMs()).toBe(60 * 60 * 1000);
  });

  it('respects an explicit minute value', () => {
    process.env.JOB_CLEANUP_AFTER_MINUTES = '5';
    expect(getCleanupDelayMs()).toBe(5 * 60 * 1000);
  });

  it('returns 0 when env is "0" (disables runtime cleanup)', () => {
    process.env.JOB_CLEANUP_AFTER_MINUTES = '0';
    expect(getCleanupDelayMs()).toBe(0);
  });

  it('clamps negative values to 0', () => {
    process.env.JOB_CLEANUP_AFTER_MINUTES = '-10';
    expect(getCleanupDelayMs()).toBe(0);
  });

  it('falls back to 60 minutes on non-numeric input', () => {
    process.env.JOB_CLEANUP_AFTER_MINUTES = 'soon-ish';
    expect(getCleanupDelayMs()).toBe(60 * 60 * 1000);
  });
});
