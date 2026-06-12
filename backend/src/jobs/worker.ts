/**
 * Async pipeline worker.
 *
 * Step 2 scope: pending → splitting → done.
 * Step 3 (audio render) will add: splitting → rendering → done.
 *
 * Fire-and-forget: routes/upload.ts calls runPipeline(jobId) and immediately
 * responds to the client. The client then polls /status/:jobId.
 */

import { updateJob } from './jobQueue';
import { findUploadFor } from '../utils/paths';
import { splitToMidis } from '../pipeline/splitParts';

export async function runPipeline(jobId: string): Promise<void> {
  try {
    const inputPath = findUploadFor(jobId);
    if (!inputPath) {
      throw new Error(`Upload file for job ${jobId} not found`);
    }

    updateJob(jobId, { status: 'splitting' });
    const result = await splitToMidis(jobId, inputPath);
    console.log(
      `[job ${jobId}] split done: tempo=${result.tempo}, parts=${result.partNames.join('/')}`,
    );

    // Step 3 will insert: updateJob(jobId, { status: 'rendering' }); await renderAudio(...)
    updateJob(jobId, { status: 'done' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[job ${jobId}] pipeline failed:`, message);
    updateJob(jobId, { status: 'failed', error: message });
  }
}
