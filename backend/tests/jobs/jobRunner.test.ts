/**
 * Tests for the bounded-concurrency runner (jobs/jobRunner.ts).
 *
 * Strategy: swap the pipeline function via _setPipelineFn with a deferred
 * promise we control, so we can assert exactly when slots free up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueue,
  getMaxConcurrency,
  _inspect,
  _setPipelineFn,
  _resetPipelineFn,
  _drainQueue,
} from '../../src/jobs/jobRunner';

type Deferred = {
  jobId: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
};

function makeDeferred(jobId: string): Deferred {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { jobId, promise, resolve, reject };
}

/** Yield long enough for all microtasks (promise .finally + pump) to drain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('jobRunner – getMaxConcurrency', () => {
  const originalEnv = process.env.JOB_MAX_CONCURRENCY;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.JOB_MAX_CONCURRENCY;
    else process.env.JOB_MAX_CONCURRENCY = originalEnv;
  });

  it('defaults to 2 when env unset', () => {
    delete process.env.JOB_MAX_CONCURRENCY;
    expect(getMaxConcurrency()).toBe(2);
  });

  it('respects explicit value', () => {
    process.env.JOB_MAX_CONCURRENCY = '4';
    expect(getMaxConcurrency()).toBe(4);
  });

  it('falls back to default for 0', () => {
    process.env.JOB_MAX_CONCURRENCY = '0';
    expect(getMaxConcurrency()).toBe(2);
  });

  it('falls back to default for negative', () => {
    process.env.JOB_MAX_CONCURRENCY = '-5';
    expect(getMaxConcurrency()).toBe(2);
  });

  it('falls back to default for garbage', () => {
    process.env.JOB_MAX_CONCURRENCY = 'banana';
    expect(getMaxConcurrency()).toBe(2);
  });
});

describe('jobRunner – enqueue/pump behaviour', () => {
  beforeEach(() => {
    _drainQueue();
    process.env.JOB_MAX_CONCURRENCY = '2';
  });

  afterEach(() => {
    _drainQueue();
    _resetPipelineFn();
    delete process.env.JOB_MAX_CONCURRENCY;
  });

  it('runs up to max concurrency and queues the rest', async () => {
    const deferreds: Record<string, Deferred> = {};
    _setPipelineFn(async (id) => {
      const d = makeDeferred(id);
      deferreds[id] = d;
      await d.promise;
    });

    enqueue('a');
    enqueue('b');
    enqueue('c');
    enqueue('d');
    enqueue('e');
    await flush();

    expect(_inspect()).toEqual({ running: 2, queued: 3 });

    // Resolve one – next dequeues.
    deferreds['a'].resolve();
    await flush();
    expect(_inspect()).toEqual({ running: 2, queued: 2 });

    // Drain the rest so afterEach is clean.
    deferreds['b'].resolve();
    await flush();
    deferreds['c'].resolve();
    await flush();
    deferreds['d'].resolve();
    await flush();
    deferreds['e'].resolve();
    await flush();
    expect(_inspect()).toEqual({ running: 0, queued: 0 });
  });

  it('frees the slot when a pipeline rejects', async () => {
    const deferreds: Record<string, Deferred> = {};
    _setPipelineFn(async (id) => {
      const d = makeDeferred(id);
      deferreds[id] = d;
      await d.promise;
    });

    enqueue('x');
    enqueue('y');
    enqueue('z');
    await flush();
    expect(_inspect()).toEqual({ running: 2, queued: 1 });

    // Silence the expected console.error from the runner's catch.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    deferreds['x'].reject(new Error('boom'));
    await flush();
    errSpy.mockRestore();

    // Slot freed, z dequeued.
    expect(_inspect()).toEqual({ running: 2, queued: 0 });

    deferreds['y'].resolve();
    deferreds['z'].resolve();
    await flush();
    expect(_inspect()).toEqual({ running: 0, queued: 0 });
  });

  it('honours concurrency=1 from env', async () => {
    process.env.JOB_MAX_CONCURRENCY = '1';
    const deferreds: Record<string, Deferred> = {};
    _setPipelineFn(async (id) => {
      const d = makeDeferred(id);
      deferreds[id] = d;
      await d.promise;
    });

    enqueue('p');
    enqueue('q');
    enqueue('r');
    await flush();

    expect(_inspect()).toEqual({ running: 1, queued: 2 });

    deferreds['p'].resolve();
    await flush();
    expect(_inspect()).toEqual({ running: 1, queued: 1 });

    deferreds['q'].resolve();
    await flush();
    deferreds['r'].resolve();
    await flush();
    expect(_inspect()).toEqual({ running: 0, queued: 0 });
  });

  it('calls the pipeline function with each enqueued jobId in FIFO order', async () => {
    const calls: string[] = [];
    _setPipelineFn(async (id) => {
      calls.push(id);
      // Resolve immediately; concurrency=2 means all complete before flush ends.
    });

    enqueue('one');
    enqueue('two');
    enqueue('three');
    await flush();

    expect(calls).toEqual(['one', 'two', 'three']);
    expect(_inspect()).toEqual({ running: 0, queued: 0 });
  });
});
