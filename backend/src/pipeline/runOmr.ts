/**
 * PDF → MusicXML via Audiveris (OMR).
 *
 * Shells out to the Audiveris CLI. Audiveris is GPL-licensed Java software
 * that bundles its own JRE in the .deb release; we install it system-wide
 * and call the launcher script directly (it's not on PATH).
 *
 * CLI invocation:
 *   Audiveris -batch -export -output <workDir> -- <input.pdf>
 *
 * Audiveris derives the output basename from the input filename, so for an
 * input of `<jobId>.pdf` it produces `<jobId>.mxl` plus a sibling `<jobId>.omr`
 * (its internal book file) and a `<jobId>-<timestamp>.log`. We return the
 * .mxl path; the splitter consumes that directly via readMusicXml.
 *
 * Env:
 *   AUDIVERIS_BIN          default: /opt/audiveris/bin/Audiveris
 *   AUDIVERIS_TIMEOUT_MS   default: 180000 (3 minutes)
 *
 * NOTE: the binary path is hard-coded to the absolute install location
 * because the .deb does NOT add Audiveris to PATH (Ubuntu 24.04, 5.10.2).
 * Override via env if you've installed it elsewhere.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { workDirFor } from '../utils/paths';

const execFileP = promisify(execFile);

const AUDIVERIS_BIN = process.env.AUDIVERIS_BIN ?? '/opt/audiveris/bin/Audiveris';
const AUDIVERIS_TIMEOUT_MS = Number(process.env.AUDIVERIS_TIMEOUT_MS ?? 180_000);

export function getAudiverisBin(): string {
  return AUDIVERIS_BIN;
}

export interface OmrResult {
  /** Absolute path to the produced .mxl file. */
  musicXmlPath: string;
}

/**
 * Run OMR on the given PDF, dropping outputs into the job's work directory.
 * Throws if Audiveris fails to produce an .mxl within the timeout.
 */
export async function runOmr(jobId: string, pdfPath: string): Promise<OmrResult> {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF not found: ${pdfPath}`);
  }
  const ext = path.extname(pdfPath).toLowerCase();
  if (ext !== '.pdf') {
    throw new Error(`runOmr expected .pdf, got ${ext}`);
  }

  const outDir = workDirFor(jobId);
  const baseName = path.basename(pdfPath, ext); // e.g. "<jobId>"
  const expectedMxl = path.join(outDir, `${baseName}.mxl`);

  const args = [
    '-batch',
    '-export',
    '-output',
    outDir,
    '--',
    pdfPath,
  ];

  let stdout: string;
  let stderr: string;
  try {
    const result = await execFileP(AUDIVERIS_BIN, args, {
      timeout: AUDIVERIS_TIMEOUT_MS,
      // Audiveris is chatty on stdout; bump beyond default 1 MB cap.
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    if (e.code === 'ENOENT') {
      throw new Error(
        `Audiveris binary not found at ${AUDIVERIS_BIN}. ` +
          'Install Audiveris 5.10+ (https://github.com/Audiveris/audiveris/releases) ' +
          'or set AUDIVERIS_BIN.',
        { cause: err },
      );
    }
    if (e.killed && e.signal === 'SIGTERM') {
      throw new Error(
        `OMR timed out after ${AUDIVERIS_TIMEOUT_MS} ms. ` +
          'Try a smaller PDF, a higher-quality scan, or increase AUDIVERIS_TIMEOUT_MS.',
        { cause: err },
      );
    }
    const tail = (e.stderr ?? e.stdout ?? e.message).split('\n').slice(-10).join('\n');
    throw new Error(`Audiveris failed: ${tail}`, { cause: err });
  }

  if (!fs.existsSync(expectedMxl)) {
    // OMR ran but didn't emit the expected .mxl — usually means Audiveris
    // failed to detect any pages (e.g. PDF was scanned at very low DPI or
    // is a non-music document). Surface a friendly hint.
    const tail = (stderr || stdout).split('\n').slice(-10).join('\n');
    throw new Error(
      `OMR produced no MusicXML output. ` +
        `Expected ${path.basename(expectedMxl)} in work dir. ` +
        `This often means Audiveris could not recognize music notation in the PDF ` +
        `(very low scan DPI, handwritten music, or a non-music document). ` +
        `Audiveris log tail:\n${tail}`,
    );
  }

  return { musicXmlPath: expectedMxl };
}
