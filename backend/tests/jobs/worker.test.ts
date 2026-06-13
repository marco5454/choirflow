/**
 * Tests for runPipeline (jobs/worker.ts).
 *
 * The worker orchestrates three pipeline stages — runOmr, splitToMidis,
 * renderAudio — and updates the job's status as it transitions. We mock
 * all three so this file does not invoke Audiveris, fluidsynth, or ffmpeg.
 *
 * The upload file is planted directly in UPLOADS_DIR (the worker uses
 * `findUploadFor`, which is just a readdir scan), so we exercise the real
 * branch logic between PDF and MusicXML uploads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../src/pipeline/runOmr', () => ({
  runOmr: vi.fn(),
}));
vi.mock('../../src/pipeline/splitParts', () => ({
  splitToMidis: vi.fn(),
}));
vi.mock('../../src/pipeline/renderAudio', () => ({
  renderAudio: vi.fn(),
}));

import { runPipeline } from '../../src/jobs/worker';
import { createJob, getJob } from '../../src/jobs/jobQueue';
import { UPLOADS_DIR, mp3PathFor } from '../../src/utils/paths';
import { runOmr } from '../../src/pipeline/runOmr';
import { splitToMidis } from '../../src/pipeline/splitParts';
import { renderAudio } from '../../src/pipeline/renderAudio';

const createdJobIds = new Set<string>();
const createdUploadPaths = new Set<string>();

function jobId(suffix: string): string {
  const id = `test-worker-${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdJobIds.add(id);
  return id;
}

/** Plant a fake upload file at UPLOADS_DIR/<jobId>.<ext>. Returns its path. */
function plantUpload(id: string, ext: '.musicxml' | '.pdf'): string {
  const p = path.join(UPLOADS_DIR, `${id}${ext}`);
  fs.writeFileSync(p, Buffer.from('fake-input', 'utf8'));
  createdUploadPaths.add(p);
  return p;
}

beforeEach(() => {
  vi.mocked(runOmr).mockReset();
  vi.mocked(splitToMidis).mockReset();
  vi.mocked(renderAudio).mockReset();
});

afterEach(() => {
  for (const p of createdUploadPaths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  createdUploadPaths.clear();
  createdJobIds.clear();
});

describe('runPipeline – MusicXML happy path', () => {
  it('skips OMR and transitions pending → splitting → rendering → done', async () => {
    const id = jobId('xml-ok');
    createJob(id);
    const uploadPath = plantUpload(id, '.musicxml');

    // Capture the job status observed at each stage so we can assert order.
    const statusAtSplit = vi.fn();
    const statusAtRender = vi.fn();

    vi.mocked(splitToMidis).mockImplementation(async () => {
      statusAtSplit(getJob(id)?.status);
      return { tempo: 120, partNames: ['S', 'A', 'T', 'B'], midiPaths: {} as never };
    });
    vi.mocked(renderAudio).mockImplementation(async () => {
      statusAtRender(getJob(id)?.status);
      return { mp3Paths: { soprano: mp3PathFor(id, 'soprano') } as never };
    });

    await runPipeline(id);

    expect(runOmr).not.toHaveBeenCalled();
    expect(splitToMidis).toHaveBeenCalledTimes(1);
    expect(splitToMidis).toHaveBeenCalledWith(id, uploadPath);
    expect(renderAudio).toHaveBeenCalledTimes(1);
    expect(renderAudio).toHaveBeenCalledWith(id);

    expect(statusAtSplit).toHaveBeenCalledWith('splitting');
    expect(statusAtRender).toHaveBeenCalledWith('rendering');
    expect(getJob(id)?.status).toBe('done');
    expect(getJob(id)?.error).toBeUndefined();
    expect(getJob(id)?.failedStage).toBeUndefined();
  });
});

describe('runPipeline – PDF happy path', () => {
  it('runs OMR first, then split + render, ending in done', async () => {
    const id = jobId('pdf-ok');
    createJob(id);
    const uploadPath = plantUpload(id, '.pdf');

    const statusAtOmr = vi.fn();
    const omrXmlPath = path.join(UPLOADS_DIR, `${id}.from-omr.xml`);

    vi.mocked(runOmr).mockImplementation(async () => {
      statusAtOmr(getJob(id)?.status);
      return { musicXmlPath: omrXmlPath };
    });
    vi.mocked(splitToMidis).mockResolvedValue({
      tempo: 120,
      partNames: ['S', 'A', 'T', 'B'],
      midiPaths: {} as never,
    });
    vi.mocked(renderAudio).mockResolvedValue({
      mp3Paths: {} as never,
    });

    await runPipeline(id);

    expect(runOmr).toHaveBeenCalledTimes(1);
    expect(runOmr).toHaveBeenCalledWith(id, uploadPath);
    expect(statusAtOmr).toHaveBeenCalledWith('omr');

    // splitToMidis should be called with the OMR-produced XML path, not the original PDF.
    expect(splitToMidis).toHaveBeenCalledTimes(1);
    expect(splitToMidis).toHaveBeenCalledWith(id, omrXmlPath);

    expect(renderAudio).toHaveBeenCalledTimes(1);
    expect(getJob(id)?.status).toBe('done');
    expect(getJob(id)?.failedStage).toBeUndefined();
  });
});

describe('runPipeline – failure modes', () => {
  it('marks failed when no upload file exists for the jobId', async () => {
    const id = jobId('no-upload');
    createJob(id);
    // Deliberately do NOT plant any file.

    await runPipeline(id);

    const job = getJob(id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/Upload file.*not found/i);
    expect(job?.failedStage).toBe('pending');

    expect(runOmr).not.toHaveBeenCalled();
    expect(splitToMidis).not.toHaveBeenCalled();
    expect(renderAudio).not.toHaveBeenCalled();
  });

  it('marks failed at omr when runOmr throws (PDF upload)', async () => {
    const id = jobId('omr-err');
    createJob(id);
    plantUpload(id, '.pdf');

    vi.mocked(runOmr).mockRejectedValue(new Error('audiveris choked'));

    await runPipeline(id);

    const job = getJob(id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('audiveris choked');
    expect(job?.failedStage).toBe('omr');
    expect(splitToMidis).not.toHaveBeenCalled();
    expect(renderAudio).not.toHaveBeenCalled();
  });

  it('marks failed when splitToMidis throws (render not invoked)', async () => {
    const id = jobId('split-err');
    createJob(id);
    plantUpload(id, '.musicxml');

    vi.mocked(splitToMidis).mockRejectedValue(new Error('bad musicxml'));

    await runPipeline(id);

    const job = getJob(id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('bad musicxml');
    expect(job?.failedStage).toBe('splitting');
    expect(renderAudio).not.toHaveBeenCalled();
  });

  it('marks failed when renderAudio throws (status was rendering at the time)', async () => {
    const id = jobId('render-err');
    createJob(id);
    plantUpload(id, '.musicxml');

    vi.mocked(splitToMidis).mockResolvedValue({
      tempo: 120,
      partNames: ['S', 'A', 'T', 'B'],
      midiPaths: {} as never,
    });

    let statusAtRender: string | undefined;
    vi.mocked(renderAudio).mockImplementation(async () => {
      statusAtRender = getJob(id)?.status;
      throw new Error('fluidsynth exploded');
    });

    await runPipeline(id);

    expect(statusAtRender).toBe('rendering');
    const job = getJob(id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('fluidsynth exploded');
    expect(job?.failedStage).toBe('rendering');
  });
});
