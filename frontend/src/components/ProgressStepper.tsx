import type { JobStatus } from '../types';

const PROGRESS_STEPS: Array<{ key: Exclude<JobStatus, 'failed'>; label: string }> = [
  { key: 'pending', label: 'Queued' },
  { key: 'omr', label: 'Reading PDF' },
  { key: 'splitting', label: 'Splitting' },
  { key: 'rendering', label: 'Rendering' },
  { key: 'done', label: 'Done' },
];

export function ProgressStepper({
  status,
  failedStage,
}: {
  status: JobStatus;
  failedStage: JobStatus | null;
}) {
  const failed = status === 'failed';
  // When failed, the "current" step (red) is the stage that was active at failure.
  // If the backend didn't tell us, fall back to dimming everything.
  const failedIdx = failed
    ? PROGRESS_STEPS.findIndex((s) => s.key === failedStage)
    : -1;
  const currentIdx = failed
    ? failedIdx
    : PROGRESS_STEPS.findIndex((s) => s.key === status);

  return (
    <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {PROGRESS_STEPS.map((step, i) => {
        const isFailed = failed && i === currentIdx;
        const isCurrent = !failed && i === currentIdx;
        const isPast = i >= 0 && currentIdx >= 0 && i < currentIdx;
        const isFuture = currentIdx === -1 || (i > currentIdx && !isFailed);

        let dot: React.ReactNode;
        if (isFailed) {
          dot = (
            <span
              className="inline-block h-2 w-2 rounded-full bg-red-500"
              aria-hidden
            />
          );
        } else if (isCurrent) {
          dot = (
            <span
              className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-500"
              aria-hidden
            />
          );
        } else {
          dot = (
            <span
              className={
                'inline-block h-2 w-2 rounded-full ' +
                (isPast ? 'bg-indigo-500' : 'bg-slate-300')
              }
              aria-hidden
            />
          );
        }

        let labelClass: string;
        if (isFailed) labelClass = 'font-semibold text-red-700';
        else if (isCurrent) labelClass = 'font-semibold text-slate-900';
        else if (isPast) labelClass = 'text-slate-700';
        else if (isFuture) labelClass = 'text-slate-400';
        else labelClass = 'text-slate-500';

        return (
          <li key={step.key} className="flex items-center gap-2">
            {dot}
            <span className={labelClass}>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
