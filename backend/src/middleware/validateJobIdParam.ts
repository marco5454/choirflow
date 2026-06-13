import type { Request, Response, NextFunction } from 'express';
import { isValidJobId } from '../utils/jobId';

/**
 * Express middleware that rejects any request whose `:jobId` path param is
 * not a strict uuid-v4 string. Mounted on /status and /download routers so it
 * runs before any filesystem helper sees the value.
 *
 * Returns 400 `{ error: 'Invalid jobId' }` on miss; calls `next()` on hit.
 */
export function validateJobIdParam(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const { jobId } = req.params;
  if (!isValidJobId(jobId)) {
    res.status(400).json({ error: 'Invalid jobId' });
    return;
  }
  next();
}
