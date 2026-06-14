import { useState } from 'react';
import { JobPanel } from './components/JobPanel';
import { UploadForm } from './components/UploadForm';
import { useJobStatus } from './hooks/useJobStatus';
import type { JobStatus, UploadResponse } from './types';

function App() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [initialStatus, setInitialStatus] = useState<JobStatus | null>(null);
  const [originalName, setOriginalName] = useState<string | null>(null);

  const { status, error: jobError, failedStage } = useJobStatus(jobId, initialStatus);

  const onUploaded = (data: UploadResponse, fallbackName: string) => {
    setJobId(data.jobId);
    setInitialStatus(data.status);
    setOriginalName(data.originalName ?? fallbackName);
  };

  const onReset = () => {
    setJobId(null);
    setInitialStatus(null);
    setOriginalName(null);
  };

  const jobInProgress =
    status !== null && status !== 'done' && status !== 'failed';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">ChoirFlow</h1>
          <p className="mt-1 text-sm text-slate-600">
            Upload SATB sheet music (MusicXML or PDF) and get one practice MP3 per voice.
          </p>
        </header>

        <UploadForm
          jobInProgress={jobInProgress}
          showReset={jobId !== null}
          onUploaded={onUploaded}
          onReset={onReset}
        />

        {jobId && status && (
          <JobPanel
            jobId={jobId}
            status={status}
            originalName={originalName}
            failedStage={failedStage}
            jobError={jobError}
          />
        )}
      </div>
    </div>
  );
}

export default App;
