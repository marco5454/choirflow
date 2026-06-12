/**
 * Verify splitToMidis against a few fixtures, including:
 *  - the 4-part open-score fixture (regression check)
 *  - the closed-score (2-part) fixture (new feature)
 *
 * Also runs against any extra .xml file passed on the command line.
 *
 * Run:
 *   npx ts-node scripts/verify-split.ts
 *   npx ts-node scripts/verify-split.ts /path/to/your/file.xml
 */

import path from 'path';
import fs from 'fs';
import { splitToMidis, MusicXmlValidationError } from '../src/pipeline/splitParts';
import { ensureBootDirs, midiPathFor, VOICES } from '../src/utils/paths';

async function runOne(label: string, jobId: string, xmlPath: string): Promise<void> {
  console.log(`\n=== ${label} ===`);
  console.log(`  fixture: ${xmlPath}`);
  if (!fs.existsSync(xmlPath)) {
    console.log(`  SKIP (file does not exist)`);
    return;
  }
  try {
    const result = await splitToMidis(jobId, xmlPath);
    console.log(`  tempo: ${result.tempo} BPM`);
    console.log(`  partNames: ${JSON.stringify(result.partNames)}`);
    for (const v of VOICES) {
      const p = midiPathFor(jobId, v);
      const size = fs.existsSync(p) ? fs.statSync(p).size : -1;
      console.log(`    ${v}: ${p} (${size} bytes)`);
    }
    console.log('  OK');
  } catch (err) {
    if (err instanceof MusicXmlValidationError) {
      console.error(`  FAIL (validation): ${err.message}`);
    } else {
      console.error(`  FAIL (unexpected):`, err);
    }
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  ensureBootDirs();

  const fixturesDir = path.resolve(__dirname, '..', 'tests', 'fixtures');

  await runOne(
    'open-score (4 parts) — existing fixture',
    'verify-open-score',
    path.join(fixturesDir, 'satb-sample.xml'),
  );

  await runOne(
    'closed-score (2 parts) — minimal music21-style fixture',
    'verify-closed-score',
    path.join(fixturesDir, 'satb-closed-score.xml'),
  );

  // Optionally run against any extra files passed in argv.
  const extras = process.argv.slice(2);
  for (let i = 0; i < extras.length; i++) {
    await runOne(`user-supplied #${i + 1}`, `verify-extra-${i + 1}`, path.resolve(extras[i]));
  }
}

main().catch((err) => {
  console.error('verify-split crashed:', err);
  process.exit(1);
});
