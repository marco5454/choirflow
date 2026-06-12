/**
 * Tiny MIDI inspector for verification: prints note-on events with timing
 * for each .mid file produced by verify-split.ts.
 *
 * Run after verify-split.ts:
 *   npx ts-node scripts/inspect-midi.ts <jobId>
 * e.g.
 *   npx ts-node scripts/inspect-midi.ts verify-closed-score
 */

import fs from 'fs';
import path from 'path';
import { midiPathFor, VOICES } from '../src/utils/paths';

function readVarLen(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let i = offset;
  for (;;) {
    const b = buf[i++];
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiToName(n: number): string {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

interface MidiEvent {
  tick: number;
  type: 'on' | 'off';
  pitch: number;
}

function parseMidi(buf: Buffer): { ppq: number; events: MidiEvent[] } {
  // Header
  if (buf.toString('ascii', 0, 4) !== 'MThd') throw new Error('not a MIDI file');
  const ppq = buf.readUInt16BE(12);

  let pos = 14;
  // Find first MTrk
  if (buf.toString('ascii', pos, pos + 4) !== 'MTrk') throw new Error('expected MTrk');
  const trackLen = buf.readUInt32BE(pos + 4);
  pos += 8;
  const end = pos + trackLen;

  const events: MidiEvent[] = [];
  let tick = 0;
  let runningStatus = 0;

  while (pos < end) {
    const dt = readVarLen(buf, pos);
    tick += dt.value;
    pos = dt.next;

    let status = buf[pos];
    if (status < 0x80) {
      // running status
      status = runningStatus;
    } else {
      pos++;
      runningStatus = status;
    }

    const high = status & 0xf0;
    if (high === 0x90) {
      // note on
      const pitch = buf[pos++];
      const vel = buf[pos++];
      events.push({ tick, type: vel === 0 ? 'off' : 'on', pitch });
    } else if (high === 0x80) {
      const pitch = buf[pos++];
      pos++; // velocity
      events.push({ tick, type: 'off', pitch });
    } else if (high === 0xa0 || high === 0xb0 || high === 0xe0) {
      pos += 2;
    } else if (high === 0xc0 || high === 0xd0) {
      pos += 1;
    } else if (status === 0xff) {
      // meta
      pos++; // type byte
      const len = readVarLen(buf, pos);
      pos = len.next + len.value;
    } else if (status === 0xf0 || status === 0xf7) {
      const len = readVarLen(buf, pos);
      pos = len.next + len.value;
    } else {
      // Unknown byte; bail.
      break;
    }
  }
  return { ppq, events };
}

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
    const { ppq, events } = parseMidi(fs.readFileSync(p));
    const ons = events.filter((e) => e.type === 'on');
    console.log(`\n${voice} (${path.basename(p)}, ppq=${ppq}, ${ons.length} note-ons):`);
    for (const e of ons) {
      console.log(`  tick=${e.tick.toString().padStart(5)}  ${midiToName(e.pitch)}`);
    }
  }
}

main();
