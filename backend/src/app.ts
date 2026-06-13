/**
 * Express application factory.
 *
 * Returns a configured `Express` instance with no side-effects on import:
 * no directory creation, no preflight checks, no port binding. The boot
 * entrypoint (`server.ts`) is responsible for environment setup; this
 * module is responsible only for HTTP wiring, and is the seam used by
 * tests (supertest binds to the returned `app` directly).
 */

import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import uploadRouter from './routes/upload';
import statusRouter from './routes/status';
import downloadRouter from './routes/download';
import { createUploadRateLimiter } from './middleware/uploadRateLimit';
import { logger } from './utils/logger';

export function createApp(): express.Express {
  const app = express();

  // Per-request access log: one line on receipt, one on completion with status
  // and duration. /health is skipped to avoid spamming load-balancer pings.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') {
      next();
      return;
    }
    const start = process.hrtime.bigint();
    logger.info({ method: req.method, path: req.path }, 'request received');
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(durationMs),
        },
        'request completed',
      );
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Rate limit only the upload endpoint (status/download are cheap reads).
  app.use('/upload', createUploadRateLimiter());

  app.use(uploadRouter);
  app.use(statusRouter);
  app.use(downloadRouter);

  // Centralized error handler (catches multer errors, etc.)
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: err.message });
  });

  return app;
}
