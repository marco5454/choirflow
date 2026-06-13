/**
 * Tests for POST /upload.
 *
 * Hermetic — the worker is mocked so `runPipeline` is a no-op spy. We don't
 * actually run OMR, splitting, or rendering here; this file only verifies the
 * HTTP route's contract: validation, multer behavior, jobId allocation, and
 * the 201 response shape.
 *
 * Cleanup: any file the route writes lands in UPLOADS_DIR as `<jobId>.<ext>`
 * and is removed in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

// Mock the worker BEFORE importing the app, so the route binds to the mock.
vi.mock('../../src/jobs/worker', () => ({
  runPipeline: vi.fn(async () => {
    /* no-op for tests */
  }),
}));

import { createApp } from '../../src/app';
import { UPLOADS_DIR } from '../../src/utils/paths';
import { runPipeline } from '../../src/jobs/worker';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');
const SAMPLE_XML = path.join(FIXTURES, 'satb-sample.xml');

const app = createApp();

/** Track every file we created in UPLOADS_DIR so we can clean it up. */
const uploadedJobIds = new Set<string>();

function trackJobId(jobId: string): void {
  uploadedJobIds.add(jobId);
}

afterEach(() => {
  for (const jobId of uploadedJobIds) {
    // The route writes `<jobId>.<ext>` — discover the actual filename.
    const matches = fs
      .readdirSync(UPLOADS_DIR)
      .filter((f) => f.startsWith(`${jobId}.`));
    for (const f of matches) {
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, f));
      } catch {
        /* ignore */
      }
    }
  }
  uploadedJobIds.clear();
});

beforeEach(() => {
  vi.mocked(runPipeline).mockClear();
});

describe('POST /upload', () => {
  it('rejects a request with no file field (400)', async () => {
    const res = await request(app).post('/upload');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('rejects an unsupported extension (400)', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('not music'), 'song.txt');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported file type/i);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('rejects an oversized file (>50 MB) (400)', async () => {
    // 51 MB of zeros — multer rejects via LIMIT_FILE_SIZE, the centralized
    // error handler in app.ts converts it to a 400 JSON response.
    const big = Buffer.alloc(51 * 1024 * 1024);
    const res = await request(app)
      .post('/upload')
      .attach('file', big, 'huge.musicxml');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('accepts a valid .musicxml upload and returns 201 + job metadata', async () => {
    const res = await request(app).post('/upload').attach('file', SAMPLE_XML);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'pending',
      originalName: 'satb-sample.xml',
    });
    expect(typeof res.body.jobId).toBe('string');
    expect(res.body.jobId).toHaveLength(36); // uuid v4
    expect(res.body.storedAs).toBe(`${res.body.jobId}.xml`);
    expect(res.body.size).toBeGreaterThan(0);

    trackJobId(res.body.jobId);

    // The stored file should actually exist on disk.
    const stored = path.join(UPLOADS_DIR, res.body.storedAs);
    expect(fs.existsSync(stored)).toBe(true);

    // And the worker should have been kicked off exactly once.
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith(res.body.jobId);
  });

  it('accepts a valid .pdf upload and returns 201 (worker mocked, OMR not run)', async () => {
    // %PDF-1.4 header is the bare minimum a PDF "looks like"; the route only
    // checks extension, and the worker is mocked.
    const fakePdf = Buffer.from('%PDF-1.4\n%fake\n', 'utf8');
    const res = await request(app)
      .post('/upload')
      .attach('file', fakePdf, 'score.pdf');

    expect(res.status).toBe(201);
    expect(res.body.originalName).toBe('score.pdf');
    expect(res.body.storedAs).toBe(`${res.body.jobId}.pdf`);

    trackJobId(res.body.jobId);

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith(res.body.jobId);
  });
});
