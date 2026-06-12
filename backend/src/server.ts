import express, { Request, Response, NextFunction } from 'express';
import { ensureBootDirs, STORAGE_ROOT } from './utils/paths';
import uploadRouter from './routes/upload';
import statusRouter from './routes/status';
import downloadRouter from './routes/download';

const PORT = Number(process.env.PORT) || 3000;

ensureBootDirs();

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
