import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { createJob, getJob } from './jobs/jobQueue';

const PORT = Number(process.env.PORT) || 3000;
const STORAGE_ROOT = path.resolve(__dirname, '..', 'storage');
const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');

// Ensure upload dir exists at boot (defensive; folders are committed but storage is gitignored)
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer storage: name files <jobId>.<originalExt>
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const jobId = (req as Request & { jobId?: string }).jobId ?? uuidv4();
    (req as Request & { jobId?: string }).jobId = jobId;
    const ext = path.extname(file.originalname).toLowerCase() || '.xml';
    cb(null, `${jobId}${ext}`);
  },
});

const ALLOWED_EXT = new Set(['.xml', '.musicxml', '.mxl']);

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB cap for MVP
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error(`Unsupported file type: ${ext}. Expected .xml, .musicxml, or .mxl`));
    }
    cb(null, true);
  },
});

const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/upload', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use form field "file".' });
  }
  const jobId = (req as Request & { jobId?: string }).jobId;
  if (!jobId) {
    // Defensive: should never happen because filename() always sets it.
    return res.status(500).json({ error: 'Internal: jobId missing after upload' });
  }
  const job = createJob(jobId);
  return res.status(201).json({
    jobId: job.id,
    status: job.status,
    originalName: req.file.originalname,
    storedAs: req.file.filename,
    size: req.file.size,
  });
});

app.get('/status/:jobId', (req: Request, res: Response) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json(job);
});

// Centralized error handler (catches multer errors, etc.)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`ChoirFlow backend listening on http://localhost:${PORT}`);
  console.log(`Storage root: ${STORAGE_ROOT}`);
});
