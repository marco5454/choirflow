export const VOICES = ['soprano', 'alto', 'tenor', 'bass'] as const;
export type Voice = (typeof VOICES)[number];

export type JobStatus = 'pending' | 'omr' | 'splitting' | 'rendering' | 'done' | 'failed';

export type StatusResponse = {
  jobId: string;
  status: JobStatus;
  error?: string;
  failedStage?: JobStatus;
};

export type UploadResponse = {
  jobId: string;
  status: JobStatus;
  originalName?: string;
  storedAs?: string;
  size?: number;
};
