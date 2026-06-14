import { zipDownloadUrl } from '../lib/api';
import { VOICES, type JobStatus } from '../types';
import { ProgressStepper } from './ProgressStepper';
import { VoicePlayer } from './VoicePlayer';

export function JobPanel({
  jobId,
  status,
  originalName,
  failedStage,
  jobError,
}: {
  jobId: string;
  status: JobStatus;
  originalName: string | null;
  failedStage: JobStatus | null;
  jobError: string | null;
}) {
  return (
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
        <ProgressStepper status={status} failedStage={failedStage} />
        {status === 'omr' && (
          <p className="mt-2 text-xs text-slate-500">
            Reading the PDF with optical music recognition. This can take a couple of minutes.
          </p>
        )}
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
            href={zipDownloadUrl(jobId)}
            className="mt-2 inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-700"
          >
            Download all (.zip)
          </a>
        </div>
      )}
    </section>
  );
}
