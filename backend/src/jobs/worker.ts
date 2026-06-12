/**
 * Async pipeline worker.
 *
 * Stages: pending → splitting → rendering → done (or failed at any point).
 * Fire-and-forget: routes/upload.ts calls runPipeline(jobId) and immediately
 * responds to the client. The client then polls /status/:jobId.
 */

import { updateJob } from './jobQueue';
import { findUploadFor } from '../utils/paths';
import { splitToMidis } from '../pipeline/splitParts';
import { renderAudio } from '../pipeline/renderAudio';

export async function runPipeline(jobId: string): Promise<void> {
  try {
    const inputPath = findUploadFor(jobId);
    if (!inputPath) {
      throw new Error(`Upload file for job ${jobId} not found`);
    }

    updateJob(jobId, { status: 'splitting' });
    const splitResult = await splitToMidis(jobId, inputPath);
    console.log(
      `[job ${jobId}] split done: tempo=${splitResult.tempo}, parts=${splitResult.partNames.join('/')}`,
    );

    updateJob(jobId, { status: 'rendering' });
    const renderResult = await renderAudio(jobId);
    console.log(
      `[job ${jobId}] render done: ${Object.keys(renderResult.mp3Paths).join(', ')}`,
    );

    updateJob(jobId, { status: 'done' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[job ${jobId}] pipeline failed:`, message);
    updateJob(jobId, { status: 'failed', error: message });
  }
}
