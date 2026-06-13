/**
 * Bounded-concurrency FIFO runner for pipeline jobs.
 *
 * Why: every concurrent pipeline can spawn fluidsynth × 4 + ffmpeg × 4
 * (and audiveris/JVM for PDFs). Without a cap, N parallel uploads risks
 * OOMing a small VPS. This runner serialises that pressure.
 *
 * Behaviour:
 *  - enqueue(jobId): O(1), returns immediately. The job stays in `pending`
 *    until a slot is free; then runPipeline(jobId) is invoked.
 *  - At most JOB_MAX_CONCURRENCY pipelines run at once (default 2,
 *    overridable via env, garbage / non-positive falls back to 1).
 *  - Pipeline rejections never poison the runner: the slot is freed and
 *    the next jobId is dequeued regardless.
 *  - In-memory only: a process restart drops the queue. Matches the
 *    existing in-memory job model.
 */

import { runPipeline } from './worker';

const DEFAULT_MAX_CONCURRENCY = 2;

export function getMaxConcurrency(): number {
  const raw = process.env.JOB_MAX_CONCURRENCY;
  if (raw === undefined || raw === '') return DEFAULT_MAX_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENCY;
  return parsed;
}

const queue: string[] = [];
let running = 0;

// Indirection so tests can swap the runner. Default points at the real worker.
let pipelineFn: (jobId: string) => Promise<void> = runPipeline;

export function enqueue(jobId: string): void {
  queue.push(jobId);
  pump();
}

function pump(): void {
  const max = getMaxConcurrency();
  while (running < max && queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    running += 1;
    // Fire and forget. Rejections are swallowed by worker.ts's catch,
    // but we still defend with a `.catch` here so a future refactor
    // that lets rejections escape doesn't crash the process.
    pipelineFn(next)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[jobRunner] pipeline ${next} threw:`, msg);
      })
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

// ---- test helpers ---------------------------------------------------------

export function _inspect(): { running: number; queued: number } {
  return { running, queued: queue.length };
}

export function _setPipelineFn(fn: (jobId: string) => Promise<void>): void {
  pipelineFn = fn;
}

export function _resetPipelineFn(): void {
  pipelineFn = runPipeline;
}

export function _drainQueue(): void {
  queue.length = 0;
}
