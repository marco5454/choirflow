/**
 * Async pipeline worker.
 *
 * Stages:
 *   pending → [omr → ] splitting → rendering → done   (or `failed` at any point).
 *
 * The OMR stage runs only for PDF uploads; MusicXML uploads skip straight
 * to splitting. Fire-and-forget: routes/upload.ts calls runPipeline(jobId)
 * and immediately responds to the client. The client polls /status/:jobId.
 */

import path from 'path';
import { getJob, updateJob } from './jobQueue';
import { scheduleCleanup, getCleanupDelayMs } from './cleanup';
import { findUploadFor } from '../utils/paths';
import { runOmr } from '../pipeline/runOmr';
import { splitToMidis } from '../pipeline/splitParts';
import { renderAudio } from '../pipeline/renderAudio';

export async function runPipeline(jobId: string): Promise<void> {
  try {
    const uploadPath = findUploadFor(jobId);
    if (!uploadPath) {
      throw new Error(`Upload file for job ${jobId} not found`);
    }

    let musicXmlPath = uploadPath;
    if (path.extname(uploadPath).toLowerCase() === '.pdf') {
      updateJob(jobId, { status: 'omr' });
      const omrResult = await runOmr(jobId, uploadPath);
      musicXmlPath = omrResult.musicXmlPath;
      console.log(`[job ${jobId}] omr done: ${path.basename(musicXmlPath)}`);
    }

    updateJob(jobId, { status: 'splitting' });
    const splitResult = await splitToMidis(jobId, musicXmlPath);
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
    const failedStage = getJob(jobId)?.status;
    console.error(`[job ${jobId}] pipeline failed at ${failedStage}:`, message);
    updateJob(jobId, { status: 'failed', error: message, failedStage });
  } finally {
    // Schedule artifact cleanup whether the job succeeded or failed.
    // Reads the delay each time so env changes during long server runs are honoured.
    scheduleCleanup(jobId, getCleanupDelayMs());
  }
}
