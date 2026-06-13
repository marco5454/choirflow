/**
 * Tests for the upload rate limiter middleware.
 *
 * The limiter is constructed inside `createApp()` and reads env at that
 * moment, so each test that wants a different policy must call `createApp()`
 * after setting env vars. We use `vi.stubEnv` for clean teardown.
 *
 * The worker is mocked so successful uploads don't kick off real pipeline
 * work. We only care about the HTTP-level rate limit response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

vi.mock('../../src/jobs/worker', () => ({
  runPipeline: vi.fn(async () => {
    /* no-op for tests */
  }),
}));

import { createApp } from '../../src/app';
import { UPLOADS_DIR } from '../../src/utils/paths';
import {
  getUploadRateLimitConfig,
  createUploadRateLimiter,
} from '../../src/middleware/uploadRateLimit';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');
const SAMPLE_XML = path.join(FIXTURES, 'satb-sample.xml');

const uploadedFiles = new Set<string>();

function trackResponse(body: { storedAs?: string }): void {
  if (body.storedAs) {
    uploadedFiles.add(path.join(UPLOADS_DIR, body.storedAs));
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const f of uploadedFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
  uploadedFiles.clear();
});

describe('getUploadRateLimitConfig', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 10 / 15 min when env unset', () => {
    const cfg = getUploadRateLimitConfig();
    expect(cfg.max).toBe(10);
    expect(cfg.windowMs).toBe(15 * 60 * 1000);
  });

  it('respects explicit values from env', () => {
    vi.stubEnv('UPLOAD_RATE_MAX', '3');
    vi.stubEnv('UPLOAD_RATE_WINDOW_MINUTES', '2');
    const cfg = getUploadRateLimitConfig();
    expect(cfg.max).toBe(3);
    expect(cfg.windowMs).toBe(2 * 60 * 1000);
  });

  it('treats UPLOAD_RATE_MAX=0 as disabled', () => {
    vi.stubEnv('UPLOAD_RATE_MAX', '0');
    expect(getUploadRateLimitConfig().max).toBe(0);
  });

  it('falls back to defaults on garbage values', () => {
    vi.stubEnv('UPLOAD_RATE_MAX', 'banana');
    vi.stubEnv('UPLOAD_RATE_WINDOW_MINUTES', 'not-a-number');
    const cfg = getUploadRateLimitConfig();
    expect(cfg.max).toBe(10);
    expect(cfg.windowMs).toBe(15 * 60 * 1000);
  });

  it('clamps negative max to default (treated as garbage)', () => {
    vi.stubEnv('UPLOAD_RATE_MAX', '-5');
    expect(getUploadRateLimitConfig().max).toBe(10);
  });
});

describe('createUploadRateLimiter (no-op mode)', () => {
  it('returns a pass-through middleware when max=0', () => {
    vi.stubEnv('UPLOAD_RATE_MAX', '0');
    const mw = createUploadRateLimiter();
    // Pass-through middleware just calls next(); no rate-limit headers.
    let nextCalled = false;
    mw(
      // minimal mock req/res — pass-through never touches them
      {} as never,
      {} as never,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });
});

describe('POST /upload rate limiting (integration)', () => {
  it('allows requests up to the configured max, rejects further ones with 429', async () => {
    vi.stubEnv('UPLOAD_RATE_MAX', '2');
    vi.stubEnv('UPLOAD_RATE_WINDOW_MINUTES', '15');
    const app = createApp();

    const res1 = await request(app).post('/upload').attach('file', SAMPLE_XML);
    expect(res1.status).toBe(201);
    trackResponse(res1.body);

    const res2 = await request(app).post('/upload').attach('file', SAMPLE_XML);
    expect(res2.status).toBe(201);
    trackResponse(res2.body);

    const res3 = await request(app).post('/upload').attach('file', SAMPLE_XML);
    expect(res3.status).toBe(429);
    expect(res3.body.error).toMatch(/too many uploads/i);
  });

  it('does not rate-limit when UPLOAD_RATE_MAX=0', async () => {
    vi.stubEnv('UPLOAD_RATE_MAX', '0');
    const app = createApp();

    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/upload').attach('file', SAMPLE_XML);
      expect(res.status).toBe(201);
      trackResponse(res.body);
    }
  });

  it('does not affect non-upload endpoints', async () => {
    vi.stubEnv('UPLOAD_RATE_MAX', '1');
    const app = createApp();

    // Burn the only upload slot.
    const burn = await request(app).post('/upload').attach('file', SAMPLE_XML);
    expect(burn.status).toBe(201);
    trackResponse(burn.body);

    // /health should still respond freely.
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    }
  });
});
