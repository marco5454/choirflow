/**
 * Tiny MIDI decoder used by tests and by scripts/inspect-midi.ts.
 *
 * Parses just enough of a Standard MIDI File (SMF) to extract note-on events
 * with their absolute tick. We only consume the first MTrk chunk because
 * splitParts.ts produces single-track files (one per voice).
 */

import fs from 'fs';

export interface MidiEvent {
  tick: number;
  type: 'on' | 'off';
  pitch: number;
}

export interface ParsedMidi {
  ppq: number;
  events: MidiEvent[];
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToName(n: number): string {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

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

/**
 * Parse the SMF buffer and return ppq + chronological list of note events.
 * Note-on with velocity 0 is reported as type='off' (per MIDI convention).
 */
export function parseMidi(buf: Buffer): ParsedMidi {
  if (buf.toString('ascii', 0, 4) !== 'MThd') throw new Error('not a MIDI file');
  const ppq = buf.readUInt16BE(12);

  let pos = 14;
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
      pos++; // meta type byte
      const len = readVarLen(buf, pos);
      pos = len.next + len.value;
    } else if (status === 0xf0 || status === 0xf7) {
      const len = readVarLen(buf, pos);
      pos = len.next + len.value;
    } else {
      // Unknown byte; bail safely.
      break;
    }
  }
  return { ppq, events };
}

/** Convenience: parse a MIDI file from disk. */
export function parseMidiFile(filePath: string): ParsedMidi {
  return parseMidi(fs.readFileSync(filePath));
}

/** Just the note-on events, in order. */
export function noteOns(parsed: ParsedMidi): MidiEvent[] {
  return parsed.events.filter((e) => e.type === 'on');
}

/** Pitch names (e.g. ["C5","D5","E5"]) of all note-ons in order. */
export function noteOnNames(parsed: ParsedMidi): string[] {
  return noteOns(parsed).map((e) => midiToName(e.pitch));
}
