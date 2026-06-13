/**
 * Rate limiter for POST /upload.
 *
 * Why: uploads trigger expensive subprocess work (Audiveris OMR, fluidsynth,
 * ffmpeg) and can easily fill disk + saturate CPU if abused. A simple
 * per-IP token bucket is a cheap, effective first line of defence for an
 * MVP that is not yet behind auth or a WAF.
 *
 * Configuration (env, read at app construction time):
 *   UPLOAD_RATE_WINDOW_MINUTES  default 15
 *   UPLOAD_RATE_MAX             default 10  (set to 0 to disable)
 *
 * Note on deployment: when running behind a reverse proxy or load balancer
 * the client IP becomes the proxy IP unless `app.set('trust proxy', ...)`
 * is configured. Add that wiring at deploy time, not here.
 */

import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';

export interface UploadRateLimitConfig {
  windowMs: number;
  max: number;
}

export function getUploadRateLimitConfig(): UploadRateLimitConfig {
  const rawMinutes = process.env.UPLOAD_RATE_WINDOW_MINUTES;
  const rawMax = process.env.UPLOAD_RATE_MAX;

  const minutes = rawMinutes === undefined ? 15 : Number(rawMinutes);
  const max = rawMax === undefined ? 10 : Number(rawMax);

  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 15;
  const safeMax = Number.isFinite(max) && max >= 0 ? Math.floor(max) : 10;

  return {
    windowMs: safeMinutes * 60 * 1000,
    max: safeMax,
  };
}

/**
 * Returns an Express middleware enforcing the rate limit, or a no-op when
 * disabled (max == 0). The limiter holds its state in a closure, so each
 * call returns a fresh instance — useful for tests that want isolation.
 */
export function createUploadRateLimiter() {
  const { windowMs, max } = getUploadRateLimitConfig();

  if (max === 0) {
    // Disabled: pass through. Used in dev/tests by setting UPLOAD_RATE_MAX=0.
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: 'Too many uploads. Try again in a few minutes.',
      });
    },
  });
}
