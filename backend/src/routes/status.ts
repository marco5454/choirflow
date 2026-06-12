import { Router, Request, Response } from 'express';
import { getJob } from '../jobs/jobQueue';

const router = Router();

router.get('/status/:jobId', (req: Request, res: Response) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
});

export default router;
