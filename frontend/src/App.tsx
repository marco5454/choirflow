import { useEffect, useRef, useState } from 'react';

const VOICES = ['soprano', 'alto', 'tenor', 'bass'] as const;
type Voice = (typeof VOICES)[number];

type JobStatus = 'pending' | 'splitting' | 'rendering' | 'done' | 'failed';

type StatusResponse = {
  jobId: string;
  status: JobStatus;
  error?: string;
};

type UploadResponse = {
  jobId: string;
  status: JobStatus;
  originalName?: string;
  storedAs?: string;
  size?: number;
};

const POLL_INTERVAL_MS = 500;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = '.xml,.musicxml,.mxl';
const ACCEPTED_EXT_SET = new Set(['.xml', '.musicxml', '.mxl']);

const PROGRESS_STEPS: Array<{ key: Exclude<JobStatus, 'failed'>; label: string }> = [
  { key: 'pending', label: 'Queued' },
  { key: 'splitting', label: 'Splitting' },
  { key: 'rendering', label: 'Rendering' },
  { key: 'done', label: 'Done' },
];

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function validateFile(f: File): string | null {
  const ext = extOf(f.name);
  if (!ACCEPTED_EXT_SET.has(ext)) {
    return `Unsupported file type "${ext || '(none)'}". Use .xml, .musicxml, or .mxl.`;
  }
  if (f.size > MAX_UPLOAD_BYTES) {
    return `File is ${humanSize(f.size)}, which exceeds the 25 MB limit.`;
  }
  if (f.size === 0) {
    return 'File is empty.';
  }
  return null;
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [originalName, setOriginalName] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Poll job status while in-flight. Pauses when tab is hidden.
  useEffect(() => {
    if (!jobId) return;
    if (status === 'done' || status === 'failed') return;

    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) {
        // Pause while hidden; visibilitychange handler will resume.
        return;
      }
      try {
        const res = await fetch(`/status/${jobId}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: StatusResponse = await res.json();
        if (cancelled) return;
        setStatus(data.status);
        if (data.status === 'failed') {
          setJobError(data.error ?? 'Job failed');
          return;
        }
        if (data.status !== 'done') {
          timer = window.setTimeout(tick, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setJobError(err instanceof Error ? err.message : String(err));
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden && !cancelled) {
        // Resume immediately when tab becomes visible again.
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        tick();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    tick();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [jobId, status]);

  const acceptFile = (f: File | null) => {
    if (!f) {
      setFile(null);
      setSelectionError(null);
      return;
    }
    const err = validateFile(f);
    if (err) {
      setFile(null);
      setSelectionError(err);
      return;
    }
    setFile(f);
    setSelectionError(null);
  };

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (submitting || inProgress) return;
    setDragOver(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (submitting || inProgress) return;
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (submitting || inProgress) return;
    const f = e.dataTransfer.files?.[0] ?? null;
    acceptFile(f);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || submitting) return;
    setSubmitting(true);
    setUploadError(null);
    setJobError(null);
    setJobId(null);
    setStatus(null);
    setOriginalName(null);

    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/upload', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `upload failed (${res.status})`);
      }
      const data: UploadResponse = await res.json();
      setJobId(data.jobId);
      setStatus(data.status);
      setOriginalName(data.originalName ?? file.name);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setFile(null);
    setSelectionError(null);
    setUploadError(null);
    setJobId(null);
    setStatus(null);
    setJobError(null);
    setOriginalName(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const clearFile = () => {
    setFile(null);
    setSelectionError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const inProgress = status !== null && status !== 'done' && status !== 'failed';
  const formDisabled = submitting || inProgress;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">ChoirFlow</h1>
          <p className="mt-1 text-sm text-slate-600">
            Upload SATB sheet music (MusicXML) and get one practice MP3 per voice.
          </p>
        </header>

        <form
          onSubmit={onSubmit}
          className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
        >
          <span className="block text-sm font-medium text-slate-700">Sheet music file</span>

          <div
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => !formDisabled && fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (formDisabled) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={
              'mt-2 cursor-pointer rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors ' +
              (formDisabled
                ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60'
                : dragOver
                ? 'border-indigo-500 bg-indigo-50'
                : 'border-slate-300 bg-white hover:border-slate-400')
            }
          >
            <p className="text-sm text-slate-700">
              <span className="font-medium text-indigo-600">Click to browse</span> or drag a file here
            </p>
            <p className="mt-1 text-xs text-slate-500">.xml, .musicxml, .mxl &middot; max 25 MB</p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS}
            onChange={(e) => acceptFile(e.target.files?.[0] ?? null)}
            disabled={formDisabled}
            className="hidden"
          />

          {file && (
            <div className="mt-3 flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{file.name}</p>
                <p className="text-xs text-slate-500">{humanSize(file.size)}</p>
              </div>
              <button
                type="button"
                onClick={clearFile}
                disabled={formDisabled}
                aria-label="Remove selected file"
                className="ml-3 inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-slate-500 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-50"
              >
                &times;
              </button>
            </div>
          )}

          {selectionError && (
            <p role="alert" className="mt-2 text-xs text-red-600">
              {selectionError}
            </p>
          )}

          <div className="mt-4 flex gap-3">
            <button
              type="submit"
              disabled={!file || formDisabled}
              className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Uploading…' : 'Upload'}
            </button>
            {(jobId || uploadError || file) && (
              <button
                type="button"
                onClick={reset}
                disabled={submitting}
                className="inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Reset
              </button>
            )}
          </div>
        </form>

        {uploadError && (
          <div
            role="alert"
            className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          >
            <div className="font-semibold">Upload rejected</div>
            <p className="mt-1 whitespace-pre-wrap break-words">{uploadError}</p>
          </div>
        )}

        {jobId && status && (
          <section className="mt-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">Job</h2>
                {originalName && (
                  <p className="truncate text-sm text-slate-600">{originalName}</p>
                )}
              </div>
              <span className="font-mono text-xs text-slate-500">{jobId}</span>
            </div>

            <div className="mt-4">
              <ProgressStepper status={status} />
            </div>

            {status === 'failed' && jobError && (
              <div
                role="alert"
                className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
              >
                <div className="font-semibold">Job failed</div>
                <p className="mt-1 whitespace-pre-wrap break-words">{jobError}</p>
              </div>
            )}

            {status === 'done' && (
              <div className="mt-6 space-y-4">
                {VOICES.map((voice) => (
                  <VoicePlayer key={voice} jobId={jobId} voice={voice} />
                ))}
                <a
                  href={`/download/${jobId}/all`}
                  className="mt-2 inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-700"
                >
                  Download all (.zip)
                </a>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function ProgressStepper({ status }: { status: JobStatus }) {
  // Treat 'failed' as: every step before the failure is past, current is failed.
  // We don't know exactly which step failed without more context, so just dim everything.
  const failed = status === 'failed';
  const currentIdx = failed
    ? -1
    : PROGRESS_STEPS.findIndex((s) => s.key === status);

  return (
    <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {PROGRESS_STEPS.map((step, i) => {
        const isCurrent = !failed && i === currentIdx;
        const isPast = !failed && i < currentIdx;
        const isFuture = failed || i > currentIdx;
        return (
          <li key={step.key} className="flex items-center gap-2">
            {isCurrent ? (
              <span
                className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-500"
                aria-hidden
              />
            ) : (
              <span
                className={
                  'inline-block h-2 w-2 rounded-full ' +
                  (isPast ? 'bg-indigo-500' : 'bg-slate-300')
                }
                aria-hidden
              />
            )}
            <span
              className={
                isCurrent
                  ? 'font-semibold text-slate-900'
                  : isPast
                  ? 'text-slate-700'
                  : isFuture
                  ? 'text-slate-400'
                  : 'text-slate-500'
              }
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function VoicePlayer({ jobId, voice }: { jobId: string; voice: Voice }) {
  const src = `/download/${jobId}/${voice}`;
  const label = voice.charAt(0).toUpperCase() + voice.slice(1);
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-800">{label}</span>
        <a
          href={src}
          download={`${voice}.mp3`}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-500"
        >
          Download
        </a>
      </div>
      <audio controls preload="metadata" src={src} className="w-full">
        Your browser does not support the audio element.
      </audio>
    </div>
  );
}

export default App;
