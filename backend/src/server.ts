/**
 * Boot entrypoint.
 *
 * Performs environment setup (directory creation, preflight checks,
 * janitor sweep) and then binds the HTTP app to a port. The app itself
 * is built by `createApp()` in `app.ts` so it can be reused under test
 * without side-effects.
 */

import { createApp } from './app';
import { ensureBootDirs, sweepOldArtifacts, STORAGE_ROOT } from './utils/paths';
import { preflight } from './utils/preflight';
import { getCleanupDelayMs } from './jobs/cleanup';
import { getMaxConcurrency } from './jobs/jobRunner';
import { getUploadRateLimitConfig } from './middleware/uploadRateLimit';
import { logger } from './utils/logger';

const PORT = Number(process.env.PORT) || 3000;
const JOB_RETENTION_HOURS = Number(process.env.JOB_RETENTION_HOURS ?? 24);

ensureBootDirs();
void preflight();

// Boot-time disk sweep. Cheap and bounded by directory size; safe to run
// synchronously before binding the port.
try {
  const swept = sweepOldArtifacts(JOB_RETENTION_HOURS * 60 * 60 * 1000);
  if (swept.uploads || swept.workDirs || swept.outputDirs) {
    logger.info(
      {
        uploads: swept.uploads,
        workDirs: swept.workDirs,
        outputDirs: swept.outputDirs,
        olderThanHours: JOB_RETENTION_HOURS,
      },
      'janitor swept old artifacts',
    );
  }
} catch (err) {
  logger.warn({ err: (err as Error).message }, 'janitor sweep failed');
}

const app = createApp();

app.listen(PORT, () => {
  logger.info({ port: PORT }, `ChoirFlow backend listening on http://localhost:${PORT}`);
  logger.info({ storageRoot: STORAGE_ROOT }, 'storage root');
  const cleanupMs = getCleanupDelayMs();
  if (cleanupMs > 0) {
    logger.info({ minutes: cleanupMs / 60000 }, 'per-job cleanup scheduled after completion');
  } else {
    logger.info('per-job runtime cleanup disabled (JOB_CLEANUP_AFTER_MINUTES=0)');
  }
  const rl = getUploadRateLimitConfig();
  if (rl.max > 0) {
    logger.info(
      { max: rl.max, windowMinutes: rl.windowMs / 60000 },
      'upload rate limit configured',
    );
  } else {
    logger.info('upload rate limit disabled (UPLOAD_RATE_MAX=0)');
  }
  logger.info({ max: getMaxConcurrency() }, 'job concurrency configured');
});
