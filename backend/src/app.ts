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

export function createApp(): express.Express {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(uploadRouter);
  app.use(statusRouter);
  app.use(downloadRouter);

  // Centralized error handler (catches multer errors, etc.)
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: err.message });
  });

  return app;
}
