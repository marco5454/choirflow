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
import { logger } from '../utils/logger';

export async function runPipeline(jobId: string): Promise<void> {
  const log = logger.child({ jobId });
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
      log.info({ output: path.basename(musicXmlPath) }, 'omr done');
    }

    updateJob(jobId, { status: 'splitting' });
    const splitResult = await splitToMidis(jobId, musicXmlPath);
    log.info(
      { tempo: splitResult.tempo, parts: splitResult.partNames },
      'split done',
    );

    updateJob(jobId, { status: 'rendering' });
    const renderResult = await renderAudio(jobId);
    log.info({ voices: Object.keys(renderResult.mp3Paths) }, 'render done');

    updateJob(jobId, { status: 'done' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failedStage = getJob(jobId)?.status;
    log.error({ failedStage, err: message }, 'pipeline failed');
    updateJob(jobId, { status: 'failed', error: message, failedStage });
  } finally {
    // Schedule artifact cleanup whether the job succeeded or failed.
    // Reads the delay each time so env changes during long server runs are honoured.
    scheduleCleanup(jobId, getCleanupDelayMs());
  }
}
