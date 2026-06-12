/**
 * Tiny MIDI inspector for verification: prints note-on events with timing
 * for each .mid file produced by verify-split.ts.
 *
 * The decoding logic lives in tests/helpers/midiDecode.ts so it has a single
 * source of truth shared with the test suite.
 *
 * Run after verify-split.ts:
 *   npx ts-node scripts/inspect-midi.ts <jobId>
 * e.g.
 *   npx ts-node scripts/inspect-midi.ts verify-closed-score
 */

import fs from 'fs';
import path from 'path';
import { midiPathFor, VOICES } from '../src/utils/paths';
import { parseMidiFile, midiToName, noteOns } from '../tests/helpers/midiDecode';

function main(): void {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('Usage: ts-node scripts/inspect-midi.ts <jobId>');
    process.exit(1);
  }
  for (const voice of VOICES) {
    const p = midiPathFor(jobId, voice);
    if (!fs.existsSync(p)) {
      console.log(`${voice}: (missing ${p})`);
      continue;
    }
    const parsed = parseMidiFile(p);
    const ons = noteOns(parsed);
    console.log(`\n${voice} (${path.basename(p)}, ppq=${parsed.ppq}, ${ons.length} note-ons):`);
    for (const e of ons) {
      console.log(`  tick=${e.tick.toString().padStart(5)}  ${midiToName(e.pitch)}`);
    }
  }
}

main();
