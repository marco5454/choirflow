import express, { Request, Response, NextFunction } from 'express';
import { ensureBootDirs, sweepOldArtifacts, STORAGE_ROOT } from './utils/paths';
import { preflight } from './utils/preflight';
import uploadRouter from './routes/upload';
import statusRouter from './routes/status';
import downloadRouter from './routes/download';

const PORT = Number(process.env.PORT) || 3000;
const JOB_RETENTION_HOURS = Number(process.env.JOB_RETENTION_HOURS ?? 24);

ensureBootDirs();
void preflight();

// Boot-time disk sweep. Cheap and bounded by directory size; safe to run
// synchronously before binding the port.
try {
  const swept = sweepOldArtifacts(JOB_RETENTION_HOURS * 60 * 60 * 1000);
  if (swept.uploads || swept.workDirs || swept.outputDirs) {
    console.log(
      `[janitor] removed ${swept.uploads} upload(s), ${swept.workDirs} work dir(s), ${swept.outputDirs} output dir(s) older than ${JOB_RETENTION_HOURS}h`,
    );
  }
} catch (err) {
  console.warn('[janitor] sweep failed:', (err as Error).message);
}

const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use(uploadRouter);
app.use(statusRouter);
app.use(downloadRouter);

// Centralized error handler (catches multer errors, etc.)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`ChoirFlow backend listening on http://localhost:${PORT}`);
  console.log(`Storage root: ${STORAGE_ROOT}`);
});
