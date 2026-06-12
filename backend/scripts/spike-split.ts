/**
 * Spike: MusicXML SATB → 4 separate MIDI files.
 *
 * Throwaway script. NOT wired to the server.
 * Goal: prove fast-xml-parser + midi-writer-js can produce 4 playable MIDIs
 * from a minimal SATB MusicXML fixture.
 *
 * Scope (deliberately narrow):
 *  - Exactly 4 <part> elements, assumed order S/A/T/B (verified by part-name).
 *  - Single voice per part. <chord> notes are skipped with a warning.
 *  - Notes only: pitch (step/octave/alter), rest, duration via <duration>.
 *  - Tempo from first <sound tempo="..."/> if present, else 120.
 *  - No ties/slurs/dynamics/repeats/tuplets/key signatures honoured for playback
 *    (key signature is not needed because <alter> carries accidentals explicitly).
 *
 * Run: npm run spike
 */

import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import MidiWriter from 'midi-writer-js';

const FIXTURE = path.resolve(__dirname, '..', 'tests', 'fixtures', 'satb-sample.xml');
const OUT_DIR = path.resolve(__dirname, '..', 'tests', 'output');

// midi-writer-js: 128 ticks per quarter note (its internal "T" tick base).
const TICKS_PER_QUARTER = 128;

const VOICE_NAMES = ['soprano', 'alto', 'tenor', 'bass'] as const;
type VoiceName = (typeof VOICE_NAMES)[number];

// General MIDI program numbers. Channel/program reserved per voice for clarity.
// Using "Choir Aahs" (53, 1-indexed) for all four — feel free to change later.
const VOICE_PROGRAM: Record<VoiceName, number> = {
  soprano: 53,
  alto: 53,
  tenor: 53,
  bass: 53,
};

interface ParsedNote {
  // null = rest
  pitch: string | null;
  // duration in MusicXML divisions (relative to <divisions>)
  duration: number;
  isChord: boolean;
}

interface ParsedPart {
  partName: string;
  divisions: number;
  notes: ParsedNote[];
}

function ensureArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function stepAlterOctaveToPitch(step: string, alter: number, octave: number): string {
  // midi-writer-js accepts e.g. "C#4", "Eb5", "F4".
  let accidental = '';
  if (alter === 1) accidental = '#';
  else if (alter === 2) accidental = '##';
  else if (alter === -1) accidental = 'b';
  else if (alter === -2) accidental = 'bb';
  return `${step}${accidental}${octave}`;
}

function parsePart(partXml: any, partName: string): ParsedPart {
  const measures = ensureArray(partXml.measure);
  let divisions = 1;
  const notes: ParsedNote[] = [];

  for (const measure of measures) {
    // <attributes> may carry <divisions>. Only first occurrence matters for MVP.
    const attrs = ensureArray(measure.attributes);
    for (const a of attrs) {
      if (a.divisions !== undefined) {
        divisions = Number(a.divisions);
      }
    }

    const measureNotes = ensureArray(measure.note);
    for (const n of measureNotes) {
      const isChord = n.chord !== undefined;
      const isRest = n.rest !== undefined;
      const duration = Number(n.duration ?? 0);

      if (isRest) {
        notes.push({ pitch: null, duration, isChord: false });
        continue;
      }

      if (!n.pitch) {
        // unsupported (e.g. <unpitched>) — skip
        continue;
      }

      const step: string = String(n.pitch.step);
      const octave: number = Number(n.pitch.octave);
      const alter: number = n.pitch.alter !== undefined ? Number(n.pitch.alter) : 0;
      const pitch = stepAlterOctaveToPitch(step, alter, octave);
      notes.push({ pitch, duration, isChord });
    }
  }

  return { partName, divisions, notes };
}

function findTempo(parsedDoc: any): number {
  // Walk first part's first measure for a <sound tempo>. Good enough for spike.
  try {
    const parts = ensureArray(parsedDoc['score-partwise'].part);
    const firstPart = parts[0];
    const measures = ensureArray(firstPart.measure);
    for (const m of measures) {
      const sounds = ensureArray(m.sound);
      for (const s of sounds) {
        if (s['@_tempo']) return Number(s['@_tempo']);
      }
    }
  } catch {
    // ignore
  }
  return 120;
}

function buildTrackForVoice(part: ParsedPart, voice: VoiceName, tempo: number) {
  const track = new MidiWriter.Track();
  track.addTrackName(voice);
  track.setTempo(tempo);
  track.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: VOICE_PROGRAM[voice] }));

  let pendingRestTicks = 0;

  for (const note of part.notes) {
    if (note.isChord) {
      console.warn(`[${voice}] <chord> encountered — skipped (spike scope: single voice per part)`);
      continue;
    }

    const ticks = Math.round((note.duration / part.divisions) * TICKS_PER_QUARTER);

    if (note.pitch === null) {
      // rest → accumulate as wait for the next note
      pendingRestTicks += ticks;
      continue;
    }

    track.addEvent(
      new MidiWriter.NoteEvent({
        pitch: [note.pitch],
        duration: `T${ticks}`,
        wait: pendingRestTicks > 0 ? `T${pendingRestTicks}` : 0,
        velocity: 80,
      }),
    );
    pendingRestTicks = 0;
  }

  return track;
}

function main(): void {
  const xml = fs.readFileSync(FIXTURE, 'utf-8');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Keep <chord/>, <rest/> as empty objects rather than booleans so we can detect them.
    isArray: () => false,
    parseAttributeValue: false,
  });
  const doc = parser.parse(xml);

  const parts = ensureArray(doc['score-partwise'].part);
  if (parts.length !== 4) {
    throw new Error(`Expected 4 parts (SATB); got ${parts.length}`);
  }

  const partList = ensureArray(doc['score-partwise']['part-list']['score-part']);
  const partNames = partList.map((p: any) => String(p['part-name'] ?? '').toLowerCase());
  console.log('Detected parts:', partNames);

  // Sanity check expected ordering. We do NOT remap; we just warn.
  const expected = ['soprano', 'alto', 'tenor', 'bass'];
  for (let i = 0; i < 4; i++) {
    if (!partNames[i].includes(expected[i])) {
      console.warn(
        `WARN: part ${i} is "${partNames[i]}", expected to contain "${expected[i]}". Spike assumes S/A/T/B order.`,
      );
    }
  }

  const tempo = findTempo(doc);
  console.log(`Tempo: ${tempo} BPM`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (let i = 0; i < 4; i++) {
    const voice = VOICE_NAMES[i];
    const parsed = parsePart(parts[i], partNames[i] || voice);
    console.log(`[${voice}] divisions=${parsed.divisions}, notes=${parsed.notes.length}`);

    const track = buildTrackForVoice(parsed, voice, tempo);
    const writer = new MidiWriter.Writer([track]);
    const outPath = path.join(OUT_DIR, `${voice}.mid`);
    fs.writeFileSync(outPath, Buffer.from(writer.buildFile()));
    const size = fs.statSync(outPath).size;
    console.log(`  -> wrote ${outPath} (${size} bytes)`);
  }

  console.log('Spike complete.');
}

main();
