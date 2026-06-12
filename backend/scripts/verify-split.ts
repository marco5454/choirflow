/**
 * Verify splitToMidis against a few fixtures, including:
 *  - the 4-part open-score fixture (regression check)
 *  - the closed-score (2-part) fixture
 *  - a .mxl (compressed MusicXML) built on the fly from the open-score fixture
 *
 * Also runs against any extra file (.xml/.musicxml/.mxl) passed on the command line.
 *
 * The .mxl-builder logic lives in tests/helpers/buildMxl.ts and is shared with
 * the test suite, so this script and the tests stay in lock-step.
 *
 * Run:
 *   npx ts-node scripts/verify-split.ts
 *   npx ts-node scripts/verify-split.ts /path/to/your/file.xml
 */

import path from 'path';
import fs from 'fs';
import { splitToMidis, MusicXmlValidationError } from '../src/pipeline/splitParts';
import { ensureBootDirs, midiPathFor, VOICES, WORK_ROOT } from '../src/utils/paths';
import { buildMxlFixture } from '../tests/helpers/buildMxl';

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

  // Build an .mxl on the fly from the open-score fixture and verify it
  // produces equivalent output. The output should match the open-score run
  // byte-for-byte (same source XML, same splitter logic, same MIDI writer).
  const openSrc = path.join(fixturesDir, 'satb-sample.xml');
  if (fs.existsSync(openSrc)) {
    const mxlPath = path.join(WORK_ROOT, 'verify-mxl-from-open.mxl');
    buildMxlFixture(openSrc, mxlPath);
    await runOne('compressed (.mxl) — built from open-score fixture', 'verify-mxl', mxlPath);
  } else {
    console.log('\n=== compressed (.mxl) ===');
    console.log('  SKIP (open-score source fixture missing)');
  }

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
