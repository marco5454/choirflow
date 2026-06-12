import { Router, Request, Response } from 'express';
import fs from 'fs';
import { getJob } from '../jobs/jobQueue';
import { midiPathFor, VOICES, Voice } from '../utils/paths';

const router = Router();

/**
 * GET /download/:jobId/:part
 *   :part = soprano | alto | tenor | bass
 *
 * Step 2: serves the .mid intermediate. Step 3 will switch to .mp3 once the
 * audio render stage exists.
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

  const filePath = midiPathFor(jobId, part as Voice);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Output file missing on disk' });
  }

  res.setHeader('Content-Type', 'audio/midi');
  res.setHeader('Content-Disposition', `attachment; filename="${part}.mid"`);
  return res.sendFile(filePath);
});

export default router;
