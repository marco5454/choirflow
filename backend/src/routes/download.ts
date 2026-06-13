import type { Request, Response } from 'express';
import { Router } from 'express';
import fs from 'fs';
import archiver from 'archiver';
import { getJob } from '../jobs/jobQueue';
import type { Voice } from '../utils/paths';
import { mp3PathFor, VOICES } from '../utils/paths';

const router = Router();

/**
 * GET /download/:jobId/all
 *
 * Streams a zip containing all 4 voice MP3s. Registered before the per-part
 * route so the literal "all" segment wins over the :part param.
 */
router.get('/download/:jobId/all', (req: Request, res: Response) => {
  const { jobId } = req.params;

  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') {
    return res.status(409).json({ error: `Job not ready (status: ${job.status})` });
  }

  // Pre-flight: every expected MP3 must exist before we start streaming the
  // zip. Otherwise we'd send a 200 + partial archive and have no way to signal
  // failure to the client.
  for (const voice of VOICES) {
    const filePath = mp3PathFor(jobId, voice);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `Output file missing on disk: ${voice}.mp3` });
    }
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="choirflow-${jobId}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.on('warning', (err: Error) => {
    console.warn(`[job ${jobId}] zip warning:`, err.message);
  });
  archive.on('error', (err: Error) => {
    console.error(`[job ${jobId}] zip error:`, err.message);
    // Headers are already sent by the time archiver emits errors, so we can
    // only abort the response. The client will see a truncated stream.
    if (!res.headersSent) {
      res.status(500).json({ error: `Zip failed: ${err.message}` });
    } else {
      res.end();
    }
  });

  archive.pipe(res);
  for (const voice of VOICES) {
    archive.file(mp3PathFor(jobId, voice), { name: `${voice}.mp3` });
  }
  void archive.finalize();
});

/**
 * GET /download/:jobId/:part
 *   :part = soprano | alto | tenor | bass
 *
 * Serves the rendered MP3 once the job is done.
 */
router.get('/download/:jobId/:part', (req: Request, res: Response) => {
  const { jobId, part } = req.params;

  if (!VOICES.includes(part as Voice)) {
    return res.status(400).json({
      error: `Invalid part "${part}". Must be one of: ${VOICES.join(', ')}`,
    });
  }

  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') {
    return res.status(409).json({ error: `Job not ready (status: ${job.status})` });
  }

  const filePath = mp3PathFor(jobId, part as Voice);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Output file missing on disk' });
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${part}.mp3"`);
  return res.sendFile(filePath);
});

export default router;
