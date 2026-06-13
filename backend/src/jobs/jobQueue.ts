/**
 * In-memory job queue for MVP.
 * Job state lives in a Map keyed by jobId. State is lost on server restart — by design.
 */

export type JobStatus =
  | 'pending'    // file uploaded, waiting to be processed
  | 'omr'        // Audiveris running OMR on a PDF upload (skipped for MusicXML uploads)
  | 'splitting'  // splitter converting MusicXML → 4 MIDIs
  | 'rendering'  // FluidSynth + ffmpeg producing 4 MP3s
  | 'done'       // all 4 MP3s ready
  | 'failed';    // pipeline error; see `error` field

export interface Job {
  id: string;
  status: JobStatus;
  error?: string;
  /** Stage that was active when the pipeline threw. Set only when status === 'failed'. */
  failedStage?: JobStatus;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}

const jobs = new Map<string, Job>();

export function createJob(id: string): Job {
  const now = new Date().toISOString();
  const job: Job = {
    id,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function updateJob(
  id: string,
  patch: Partial<Pick<Job, 'status' | 'error' | 'failedStage'>>,
): Job | undefined {
  const existing = jobs.get(id);
  if (!existing) return undefined;
  const updated: Job = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, updated);
  return updated;
}

/** Test/debug helper. Not exposed via HTTP. */
export function listJobs(): Job[] {
  return Array.from(jobs.values());
}

/**
 * Remove a job from the in-memory map. Idempotent.
 * Used by the runtime cleanup scheduler once artifacts have been deleted.
 */
export function deleteJob(id: string): boolean {
  return jobs.delete(id);
}
