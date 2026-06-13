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

const PORT = Number(process.env.PORT) || 3000;
const JOB_RETENTION_HOURS = Number(process.env.JOB_RETENTION_HOURS ?? 24);

ensureBootDirs();
void preflight();

// Boot-time disk sweep. Cheap and bounded by directory size; safe to run
// synchronously before binding the port.
try {
  const swept = sweepOldArtifacts(JOB_RETENTION_HOURS * 60 * 60 * 1000);
  if (swept.uploads || swept.workDirs || swept.outputDirs) {
    console.log(
      `[janitor] removed ${swept.uploads} upload(s), ${swept.workDirs} work dir(s), ${swept.outputDirs} output dir(s) older than ${JOB_RETENTION_HOURS}h`,
    );
  }
} catch (err) {
  console.warn('[janitor] sweep failed:', (err as Error).message);
}

const app = createApp();

app.listen(PORT, () => {
  console.log(`ChoirFlow backend listening on http://localhost:${PORT}`);
  console.log(`Storage root: ${STORAGE_ROOT}`);
  const cleanupMs = getCleanupDelayMs();
  if (cleanupMs > 0) {
    console.log(`Per-job cleanup scheduled ${cleanupMs / 60000} min after completion.`);
  } else {
    console.log('Per-job runtime cleanup disabled (JOB_CLEANUP_AFTER_MINUTES=0).');
  }
});
