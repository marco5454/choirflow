/**
 * Tests for the upload-content sniff middleware.
 *
 * Two layers:
 *   1. Direct unit tests calling validateUploadContent(req, res, next)
 *      with a planted file on disk. Lets us assert cleanup behaviour.
 *   2. Integration tests through supertest that prove a renamed payload
 *      (e.g. PDF bytes uploaded as `score.xml`) is rejected with 400 by
 *      the route chain before it can reach the worker.
 *
 * The worker is mocked so successful uploads don't kick off real pipeline
 * work. The rate limiter is disabled so multiple integration uploads in
 * one suite don't run into the 10/15min default.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

vi.mock('../../src/jobs/worker', () => ({
  runPipeline: vi.fn(async () => {
    /* no-op for tests */
  }),
}));

vi.stubEnv('UPLOAD_RATE_MAX', '0');

import { createApp } from '../../src/app';
import { validateUploadContent } from '../../src/middleware/validateUploadContent';
import { UPLOADS_DIR } from '../../src/utils/paths';
import { buildMxlBuffer } from '../helpers/buildMxl';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');
const SAMPLE_XML = path.join(FIXTURES, 'satb-sample.xml');

const tmpFiles = new Set<string>();
const uploadedJobIds = new Set<string>();

function makeTmpFile(name: string, contents: Buffer | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'choirflow-sniff-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  tmpFiles.add(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles) {
    try {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tmpFiles.clear();

  for (const id of uploadedJobIds) {
    try {
      const dir = fs.readdirSync(UPLOADS_DIR);
      for (const f of dir) {
        if (f.startsWith(id + '.')) {
          fs.unlinkSync(path.join(UPLOADS_DIR, f));
        }
      }
    } catch {
      /* best-effort */
    }
  }
  uploadedJobIds.clear();
});

// Minimal fake req/res for unit tests. Only the fields the middleware reads.
function makeReq(filePath: string, originalname: string): unknown {
  return {
    file: {
      path: filePath,
      originalname,
    },
  };
}

describe('validateUploadContent (unit)', () => {
  it('passes a real .xml file through', () => {
    const req = makeReq(SAMPLE_XML, 'score.xml');
    let nextErr: unknown = 'untouched';
    validateUploadContent(req as never, {} as never, ((err?: unknown) => {
      nextErr = err;
    }) as never);
    expect(nextErr).toBeUndefined();
  });

  it('passes a real .mxl buffer through', () => {
    const xml = fs.readFileSync(SAMPLE_XML, 'utf-8');
    const mxl = buildMxlBuffer(xml, 'score.xml');
    const filePath = makeTmpFile('score.mxl', mxl);

    const req = makeReq(filePath, 'score.mxl');
    let nextErr: unknown = 'untouched';
    validateUploadContent(req as never, {} as never, ((err?: unknown) => {
      nextErr = err;
    }) as never);
    expect(nextErr).toBeUndefined();
  });

  it('passes a fake .pdf with %PDF- header through', () => {
    const filePath = makeTmpFile('score.pdf', Buffer.from('%PDF-1.4\n%fake\n', 'utf8'));
    const req = makeReq(filePath, 'score.pdf');
    let nextErr: unknown = 'untouched';
    validateUploadContent(req as never, {} as never, ((err?: unknown) => {
      nextErr = err;
    }) as never);
    expect(nextErr).toBeUndefined();
  });

  it('passes .xml with UTF-8 BOM through (regression for our reader)', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from('<?xml version="1.0"?><score-partwise/>', 'utf8');
    const filePath = makeTmpFile('score.xml', Buffer.concat([bom, body]));
    const req = makeReq(filePath, 'score.xml');
    let nextErr: unknown = 'untouched';
    validateUploadContent(req as never, {} as never, ((err?: unknown) => {
      nextErr = err;
    }) as never);
    expect(nextErr).toBeUndefined();
  });

  it('rejects PDF bytes named .xml and deletes the temp file', () => {
    const filePath = makeTmpFile('score.xml', Buffer.from('%PDF-1.4\n%fake\n', 'utf8'));
    const req = makeReq(filePath, 'score.xml');
    let captured: unknown;
    validateUploadContent(req as never, {} as never, ((err?: unknown) => {
      captured = err;
    }) as never);
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toMatch(/does not match/i);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects random bytes named .pdf and deletes the temp file', () => {
    const filePath = makeTmpFile(
      'score.pdf',
      Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]),
    );
    const req = makeReq(filePath, 'score.pdf');
    let captured: unknown;
    validateUploadContent(req as never, {} as never, ((err?: unknown) => {
      captured = err;
    }) as never);
    expect(captured).toBeInstanceOf(Error);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects non-ZIP bytes named .mxl and deletes the temp file', () => {
    const filePath = makeTmpFile('score.mxl', Buffer.from('this is not a zip\n', 'utf8'));
    const req = makeReq(filePath, 'score.mxl');
    let captured: unknown;
    validateUploadContent(req as never, {} as never, ((err?: unknown) => {
      captured = err;
    }) as never);
    expect(captured).toBeInstanceOf(Error);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects HTML/text bytes named .xml', () => {
    const filePath = makeTmpFile('score.xml', Buffer.from('<html><body>nope</body></html>', 'utf8'));
    const req = makeReq(filePath, 'score.xml');
    let captured: unknown;
    validateUploadContent(req as never, {} as never, ((err?: unknown) => {
      captured = err;
    }) as never);
    expect(captured).toBeInstanceOf(Error);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('falls through with no file (lets route emit its own 400)', () => {
    let nextErr: unknown = 'untouched';
    validateUploadContent({} as never, {} as never, ((err?: unknown) => {
      nextErr = err;
    }) as never);
    expect(nextErr).toBeUndefined();
  });
});

describe('POST /upload content sniff (integration)', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it('rejects PDF bytes uploaded with .xml extension (400, file removed)', async () => {
    const filePath = makeTmpFile('score.xml', Buffer.from('%PDF-1.4\n%fake\n', 'utf8'));

    const res = await request(app).post('/upload').attach('file', filePath);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/i);
    // Sniff middleware unlinked the temp file before we got the response;
    // the unit-level tests above already assert the unlink behaviour
    // directly, so no need to reverse-engineer it from UPLOADS_DIR here.
  });

  it('rejects garbage bytes uploaded with .mxl extension', async () => {
    const filePath = makeTmpFile('score.mxl', Buffer.from('definitely not a zip\n'));

    const res = await request(app).post('/upload').attach('file', filePath);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/i);
  });

  it('still accepts a real .xml file end-to-end', async () => {
    const res = await request(app).post('/upload').attach('file', SAMPLE_XML);
    expect(res.status).toBe(201);
    if (typeof res.body.jobId === 'string') {
      uploadedJobIds.add(res.body.jobId as string);
    }
  });
});
