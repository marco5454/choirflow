import { useEffect, useRef, useState } from 'react';

const VOICES = ['soprano', 'alto', 'tenor', 'bass'] as const;
type Voice = (typeof VOICES)[number];

type JobStatus = 'pending' | 'splitting' | 'rendering' | 'done' | 'failed';

type StatusResponse = {
  jobId: string;
  status: JobStatus;
  error?: string;
};

const POLL_INTERVAL_MS = 500;
const ACCEPTED_EXTENSIONS = '.xml,.musicxml,.mxl';

const STAGE_LABEL: Record<JobStatus, string> = {
  pending: 'Queued',
  splitting: 'Splitting parts',
  rendering: 'Rendering audio',
  done: 'Done',
  failed: 'Failed',
};

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollTimer = useRef<number | null>(null);

  // Poll job status while in-flight.
  useEffect(() => {
    if (!jobId) return;
    if (status === 'done' || status === 'failed') return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/status/${jobId}`);
        if (!res.ok) {
          throw new Error(`status ${res.status}`);
        }
        const data: StatusResponse = await res.json();
        if (cancelled) return;
        setStatus(data.status);
        if (data.status === 'failed') {
          setError(data.error ?? 'Job failed');
          return;
        }
        if (data.status !== 'done') {
          pollTimer.current = window.setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [jobId, status]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || submitting) return;
    setSubmitting(true);
    setError(null);
    setJobId(null);
    setStatus(null);

    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/upload', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `upload failed (${res.status})`);
      }
      const data: { jobId: string; status: JobStatus } = await res.json();
      setJobId(data.jobId);
      setStatus(data.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setFile(null);
    setJobId(null);
    setStatus(null);
    setError(null);
  };

  const inProgress = status !== null && status !== 'done' && status !== 'failed';

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
          <label className="block text-sm font-medium text-slate-700">
            Sheet music file
            <input
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={submitting || inProgress}
              className="mt-2 block w-full text-sm text-slate-600 file:mr-4 file:rounded-md file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700 disabled:opacity-50"
            />
          </label>
          <p className="mt-2 text-xs text-slate-500">
            Accepted: .xml, .musicxml, .mxl (max 25 MB)
          </p>

          <div className="mt-4 flex gap-3">
            <button
              type="submit"
              disabled={!file || submitting || inProgress}
              className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Uploading…' : 'Upload'}
            </button>
            {(jobId || error) && (
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

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          >
            <div className="font-semibold">Upload failed</div>
            <p className="mt-1 whitespace-pre-wrap break-words">{error}</p>
          </div>
        )}

        {jobId && status && status !== 'failed' && (
          <section className="mt-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Job</h2>
              <span className="font-mono text-xs text-slate-500">{jobId}</span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              {inProgress && (
                <span
                  className="inline-block h-3 w-3 animate-pulse rounded-full bg-indigo-500"
                  aria-hidden
                />
              )}
              <span className="text-sm text-slate-700">{STAGE_LABEL[status]}</span>
            </div>

            {status === 'done' && (
              <div className="mt-6 space-y-4">
                {VOICES.map((voice) => (
                  <VoicePlayer key={voice} jobId={jobId} voice={voice} />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
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
