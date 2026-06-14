import { useEffect, useRef, useState } from 'react';
import { fetchStatus } from '../lib/api';
import type { JobStatus } from '../types';

const POLL_INTERVAL_MS = 500;

export type JobStatusState = {
  status: JobStatus | null;
  error: string | null;
  failedStage: JobStatus | null;
};

const INITIAL_STATE: JobStatusState = {
  status: null,
  error: null,
  failedStage: null,
};

/**
 * Polls /status/:jobId at POLL_INTERVAL_MS until the job reaches a terminal
 * state (done | failed). Pauses while the tab is hidden and resumes on
 * visibilitychange.
 *
 * Effect identity depends only on `jobId` and a stable initial-status. Status
 * transitions during polling do not re-subscribe the effect.
 */
export function useJobStatus(
  jobId: string | null,
  initialStatus: JobStatus | null,
): JobStatusState {
  const [state, setState] = useState<JobStatusState>(INITIAL_STATE);
  const initialStatusRef = useRef(initialStatus);
  initialStatusRef.current = initialStatus;

  useEffect(() => {
    if (!jobId) {
      setState(INITIAL_STATE);
      return;
    }

    const seed = initialStatusRef.current;
    setState({ status: seed, error: null, failedStage: null });

    // If the upload response already told us the job is terminal, don't poll.
    if (seed === 'done' || seed === 'failed') return;

    let cancelled = false;
    let timer: number | null = null;
    // Track terminal status inside the effect rather than via deps so the
    // effect mounts once per job, not once per status transition.
    let terminal = false;

    const tick = async () => {
      if (cancelled || terminal) return;
      if (document.hidden) {
        // Pause while hidden; visibilitychange handler will resume.
        return;
      }
      try {
        const data = await fetchStatus(jobId);
        if (cancelled) return;
        setState({
          status: data.status,
          error: data.status === 'failed' ? data.error ?? 'Job failed' : null,
          failedStage: data.status === 'failed' ? data.failedStage ?? null : null,
        });
        if (data.status === 'done' || data.status === 'failed') {
          terminal = true;
          return;
        }
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    };

    const onVisibilityChange = () => {
      if (cancelled || terminal) return;
      if (!document.hidden) {
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
  }, [jobId]);

  return state;
}
