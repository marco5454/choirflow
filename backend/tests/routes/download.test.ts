/**
 * Tests for GET /download/:jobId/:part and GET /download/:jobId/all.
 *
 * We do not run the rendering pipeline. Instead we plant fake "mp3" bytes
 * (just deterministic Buffers — the routes only stream them, they don't
 * decode) at the exact paths the route reads from, then drive the route
 * with supertest. Job state is set up via createJob/updateJob.
 *
 * Cleanup: each test removes its `OUTPUT_ROOT/<jobId>/` directory afterwards.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import AdmZip from 'adm-zip';

import { createApp } from '../../src/app';
import { createJob, updateJob } from '../../src/jobs/jobQueue';
import {
  OUTPUT_ROOT,
  VOICES,
  Voice,
  mp3PathFor,
  outputDirFor,
} from '../../src/utils/paths';

const app = createApp();

const createdJobIds = new Set<string>();

function jobId(suffix: string): string {
  const id = `test-dl-${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdJobIds.add(id);
  return id;
}

/**
 * Plant a fake byte payload for each voice so the route's existsSync()
 * checks pass and sendFile/archiver have something to stream.
 */
function plantOutputs(id: string, voices: Voice[] = [...VOICES]): void {
  outputDirFor(id); // ensures the directory exists
  for (const voice of voices) {
    const buf = Buffer.from(`fake-${voice}-mp3-bytes`, 'utf8');
    fs.writeFileSync(mp3PathFor(id, voice), buf);
  }
}

afterEach(() => {
  for (const id of createdJobIds) {
    const dir = path.join(OUTPUT_ROOT, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  createdJobIds.clear();
});

describe('GET /download/:jobId/:part', () => {
  it('returns 400 for an invalid part name', async () => {
    const id = jobId('badpart');
    createJob(id);
    updateJob(id, { status: 'done' });

    const res = await request(app).get(`/download/${id}/baritone`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid part/i);
  });

  it('returns 404 for an unknown jobId', async () => {
    const res = await request(app).get('/download/no-such-job/soprano');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Job not found/i);
  });

  it('returns 409 when the job is not done', async () => {
    const id = jobId('notdone');
    createJob(id);
    updateJob(id, { status: 'rendering' });

    const res = await request(app).get(`/download/${id}/alto`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not ready/i);
    expect(res.body.error).toMatch(/rendering/);
  });

  it('returns the mp3 bytes with audio/mpeg when ready', async () => {
    const id = jobId('ok');
    createJob(id);
    updateJob(id, { status: 'done' });
    plantOutputs(id);

    const res = await request(app).get(`/download/${id}/tenor`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
    expect(res.headers['content-disposition']).toMatch(/tenor\.mp3/);
    // supertest gives us the raw body as a Buffer for binary responses.
    expect(Buffer.isBuffer(res.body) || typeof res.body === 'string').toBe(true);
    const bytes = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
    expect(bytes.toString('utf8')).toBe('fake-tenor-mp3-bytes');
  });

  it('returns 404 when the job is done but the file is missing on disk', async () => {
    const id = jobId('missing');
    createJob(id);
    updateJob(id, { status: 'done' });
    // Plant only 3 of 4 voices — bass.mp3 is missing.
    plantOutputs(id, ['soprano', 'alto', 'tenor']);

    const res = await request(app).get(`/download/${id}/bass`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Output file missing/i);
  });
});

describe('GET /download/:jobId/all', () => {
  it('returns 409 when the job is not done', async () => {
    const id = jobId('all-notdone');
    createJob(id);
    updateJob(id, { status: 'splitting' });

    const res = await request(app).get(`/download/${id}/all`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not ready/i);
  });

  it('streams a zip with all 4 voice mp3s when ready', async () => {
    const id = jobId('all-ok');
    createJob(id);
    updateJob(id, { status: 'done' });
    plantOutputs(id);

    // Tell supertest to buffer the response as a Buffer (zip is binary).
    const res = await request(app)
      .get(`/download/${id}/all`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`choirflow-${id}\\.zip`),
    );

    const zipBuf = res.body as Buffer;
    expect(Buffer.isBuffer(zipBuf)).toBe(true);
    expect(zipBuf.length).toBeGreaterThan(0);

    const zip = new AdmZip(zipBuf);
    const entries = zip.getEntries().map((e) => e.entryName).sort();
    expect(entries).toEqual(['alto.mp3', 'bass.mp3', 'soprano.mp3', 'tenor.mp3']);

    // Verify zip content matches what we planted.
    for (const voice of VOICES) {
      const entry = zip.getEntry(`${voice}.mp3`);
      expect(entry).toBeTruthy();
      const data = entry!.getData();
      expect(data.toString('utf8')).toBe(`fake-${voice}-mp3-bytes`);
    }
  });

  it('returns 404 when the job is done but one of the files is missing', async () => {
    const id = jobId('all-missing');
    createJob(id);
    updateJob(id, { status: 'done' });
    // Missing tenor.mp3 — pre-flight should reject with 404 before any zip stream starts.
    plantOutputs(id, ['soprano', 'alto', 'bass']);

    const res = await request(app).get(`/download/${id}/all`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Output file missing.*tenor\.mp3/i);
  });
});
