import type { Request, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { UPLOADS_DIR } from '../utils/paths';
import { createJob } from '../jobs/jobQueue';
import { enqueue } from '../jobs/jobRunner';
import { validateUploadContent } from '../middleware/validateUploadContent';

const ALLOWED_EXT = new Set(['.xml', '.musicxml', '.mxl', '.pdf']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const r = req as Request & { jobId?: string };
    const jobId = r.jobId ?? uuidv4();
    r.jobId = jobId;
    const ext = path.extname(file.originalname).toLowerCase() || '.xml';
    cb(null, `${jobId}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB (covers PDF scans)
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error(`Unsupported file type: ${ext}. Expected .xml, .musicxml, .mxl, or .pdf`));
    }
    cb(null, true);
  },
});

const router = Router();

router.post('/upload', upload.single('file'), validateUploadContent, (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use form field "file".' });
  }
  const jobId = (req as Request & { jobId?: string }).jobId;
  if (!jobId) {
    return res.status(500).json({ error: 'Internal: jobId missing after upload' });
  }
  const job = createJob(jobId);

  // Hand off to the bounded-concurrency runner. Job stays `pending` until
  // a slot is free; runPipeline takes over from there.
  enqueue(jobId);

  return res.status(201).json({
    jobId: job.id,
    status: job.status,
    originalName: req.file.originalname,
    storedAs: req.file.filename,
    size: req.file.size,
  });
});

export default router;
