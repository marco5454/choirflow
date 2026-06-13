import type { Request, Response } from 'express';
import { Router } from 'express';
import { getJob } from '../jobs/jobQueue';
import { validateJobIdParam } from '../middleware/validateJobIdParam';

const router = Router();

// Reject malformed jobIds (e.g. path traversal, oversized strings) before any
// filesystem helper runs.
router.param('jobId', validateJobIdParam);

router.get('/status/:jobId', (req: Request, res: Response) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
});

export default router;
