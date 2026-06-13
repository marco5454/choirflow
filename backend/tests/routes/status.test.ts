/**
 * Tests for GET /status/:jobId.
 *
 * The route is a thin read-through to the in-memory job map. We seed jobs
 * directly via createJob/updateJob and assert the response shape.
 *
 * Hermetic — no worker, no filesystem.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';

import { createApp } from '../../src/app';
import { createJob, updateJob } from '../../src/jobs/jobQueue';

const app = createApp();

describe('GET /status/:jobId', () => {
  it('returns 400 for a malformed (non-uuid) jobId', async () => {
    const res = await request(app).get('/status/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid jobId/i);
  });

  it('returns 404 for an unknown (well-formed) jobId', async () => {
    const res = await request(app).get(`/status/${uuidv4()}`);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('returns the job record for a known jobId', async () => {
    const jobId = uuidv4();
    createJob(jobId);
    updateJob(jobId, { status: 'rendering' });

    const res = await request(app).get(`/status/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: jobId,
      status: 'rendering',
    });
    expect(typeof res.body.createdAt).toBe('string');
    expect(typeof res.body.updatedAt).toBe('string');
  });
});
