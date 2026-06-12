/**
 * MusicXML → 4 separate MIDI files (Soprano, Alto, Tenor, Bass).
 *
 * Promoted from scripts/spike-split.ts. Same scope/limitations as the spike:
 *  - Exactly 4 <part> elements, assumed S/A/T/B order (warns on mismatch).
 *  - Single voice per part. <chord> notes skipped with warning.
 *  - Notes only: pitch (step/octave/alter), rest, duration via <duration>.
 *  - Tempo from first <sound tempo="..."/> if present, else 120.
 *  - No ties/slurs/dynamics/repeats/tuplets honoured.
 *
 * NOTE: .mxl (compressed MusicXML) is not yet supported. Caller should pass an
 * uncompressed .xml/.musicxml path. .mxl handling is a follow-up.
 */

import fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import MidiWriter from 'midi-writer-js';
import { midiPathFor, VOICES, Voice } from '../utils/paths';

/**
 * Thrown when the uploaded file is not a usable MusicXML score.
 * Caller (worker) records the message on the job; frontend renders it verbatim.
 */
export class MusicXmlValidationError extends Error {
  readonly code = 'MUSICXML_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'MusicXmlValidationError';
  }
}

const NOT_MUSICXML_HINT =
  'This file does not look like MusicXML. ' +
  'A valid MusicXML score has <score-partwise> or <score-timewise> as its root element. ' +
  'If you started from a PDF, online "PDF to XML" converters typically produce text-extraction XML, NOT MusicXML — ' +
  'you need OMR software (e.g. Audiveris, MuseScore PDF import, PlayScore) to get real MusicXML from a PDF.';

// midi-writer-js: 128 ticks per quarter note (its internal "T" tick base).
const TICKS_PER_QUARTER = 128;

// General MIDI: "Choir Aahs" = 53 (1-indexed). Same for all 4 voices in MVP.
const VOICE_PROGRAM: Record<Voice, number> = {
  soprano: 53,
  alto: 53,
  tenor: 53,
  bass: 53,
};

interface ParsedNote {
  pitch: string | null; // null = rest
  duration: number; // in MusicXML <divisions> units
  isChord: boolean;
}

interface ParsedPart {
  partName: string;
  divisions: number;
  notes: ParsedNote[];
}

export interface SplitResult {
  tempo: number;
  partNames: string[];
  midiPaths: Record<Voice, string>;
}

function ensureArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function stepAlterOctaveToPitch(step: string, alter: number, octave: number): string {
  let accidental = '';
  if (alter === 1) accidental = '#';
  else if (alter === 2) accidental = '##';
  else if (alter === -1) accidental = 'b';
  else if (alter === -2) accidental = 'bb';
  return `${step}${accidental}${octave}`;
}

function parsePart(partXml: any): ParsedPart {
  const measures = ensureArray(partXml.measure);
  let divisions = 1;
  const notes: ParsedNote[] = [];

  for (const measure of measures) {
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
      if (!n.pitch) continue; // unsupported (e.g. <unpitched>)

      const step = String(n.pitch.step);
      const octave = Number(n.pitch.octave);
      const alter = n.pitch.alter !== undefined ? Number(n.pitch.alter) : 0;
      notes.push({
        pitch: stepAlterOctaveToPitch(step, alter, octave),
        duration,
        isChord,
      });
    }
  }

  return { partName: '', divisions, notes };
}

function findTempo(parsedDoc: any): number {
  try {
    const parts = ensureArray(parsedDoc['score-partwise'].part);
    const measures = ensureArray(parts[0].measure);
    for (const m of measures) {
      const sounds = ensureArray(m.sound);
      for (const s of sounds) {
        if (s['@_tempo']) return Number(s['@_tempo']);
      }
    }
  } catch {
    /* ignore */
  }
  return 120;
}

function buildTrackForVoice(part: ParsedPart, voice: Voice, tempo: number) {
  const track = new MidiWriter.Track();
  track.addTrackName(voice);
  track.setTempo(tempo);
  track.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: VOICE_PROGRAM[voice] }));

  let pendingRestTicks = 0;
  let chordSkipped = 0;

  for (const note of part.notes) {
    if (note.isChord) {
      chordSkipped++;
      continue;
    }
    const ticks = Math.round((note.duration / part.divisions) * TICKS_PER_QUARTER);
    if (note.pitch === null) {
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

  if (chordSkipped > 0) {
    console.warn(`[${voice}] skipped ${chordSkipped} <chord> note(s) (single-voice MVP scope)`);
  }
  return track;
}

/**
 * Read a MusicXML file and write 4 MIDI files into the job's work dir.
 * Throws MusicXmlValidationError on bad/unsupported input.
 */
export async function splitToMidis(jobId: string, inputXmlPath: string): Promise<SplitResult> {
  const xml = await fs.promises.readFile(inputXmlPath, 'utf-8');

  // Cheap pre-parse sanity check: does this look like XML at all?
  const trimmed = xml.trimStart();
  if (!trimmed.startsWith('<')) {
    throw new MusicXmlValidationError(
      `File is not XML (no opening "<" tag found). ${NOT_MUSICXML_HINT}`,
    );
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: () => false,
    parseAttributeValue: false,
  });

  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MusicXmlValidationError(`Failed to parse XML: ${detail}. ${NOT_MUSICXML_HINT}`);
  }

  // Reject score-timewise (valid MusicXML, but we don't support it yet) and any other root.
  if (doc['score-timewise']) {
    throw new MusicXmlValidationError(
      '<score-timewise> MusicXML is not yet supported. Please export as <score-partwise> ' +
        '(the default in MuseScore, Finale, Sibelius, Dorico).',
    );
  }
  if (!doc['score-partwise']) {
    const rootKeys = Object.keys(doc).filter((k) => !k.startsWith('?'));
    const rootName = rootKeys[0] ?? '(unknown)';
    throw new MusicXmlValidationError(
      `Root element is <${rootName}>, expected <score-partwise>. ${NOT_MUSICXML_HINT}`,
    );
  }

  const parts = ensureArray(doc['score-partwise'].part);
  if (parts.length === 0) {
    throw new MusicXmlValidationError(
      'MusicXML contains no <part> elements. The score appears to be empty.',
    );
  }
  if (parts.length !== 4) {
    throw new MusicXmlValidationError(
      `Expected exactly 4 parts (Soprano, Alto, Tenor, Bass) but found ${parts.length}. ` +
        'ChoirFlow currently only supports 4-part SATB scores.',
    );
  }

  // Verify at least one part has at least one note — catches XML that is structurally a score but has no music.
  const totalNotes = parts.reduce(
    (sum: number, p: any) =>
      sum +
      ensureArray(p.measure).reduce(
        (s: number, m: any) => s + ensureArray(m.note).length,
        0,
      ),
    0,
  );
  if (totalNotes === 0) {
    throw new MusicXmlValidationError(
      'MusicXML has 4 parts but contains no <note> elements. Nothing to render.',
    );
  }

  const partList = ensureArray(doc['score-partwise']['part-list']?.['score-part']);
  const partNames = partList.map((p: any) => String(p['part-name'] ?? '').toLowerCase());

  const expected = ['soprano', 'alto', 'tenor', 'bass'];
  for (let i = 0; i < 4; i++) {
    if (partNames[i] && !partNames[i].includes(expected[i])) {
      console.warn(
        `[job ${jobId}] WARN: part ${i} is "${partNames[i]}", expected to contain "${expected[i]}". Assuming S/A/T/B order anyway.`,
      );
    }
  }

  const tempo = findTempo(doc);

  const midiPaths = {} as Record<Voice, string>;
  for (let i = 0; i < 4; i++) {
    const voice = VOICES[i];
    const parsed = parsePart(parts[i]);
    const track = buildTrackForVoice(parsed, voice, tempo);
    const writer = new MidiWriter.Writer([track]);
    const outPath = midiPathFor(jobId, voice);
    await fs.promises.writeFile(outPath, Buffer.from(writer.buildFile()));
    midiPaths[voice] = outPath;
  }

  return { tempo, partNames, midiPaths };
}
