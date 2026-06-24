/**
 * Tests for splitParts.ts: MusicXML → 4 MIDI files.
 *
 * Hermetic — uses fixtures under tests/fixtures only, no external binaries,
 * no network. MIDIs are written to backend/storage/work/<jobId>/ via the
 * existing path helpers and cleaned up after each test.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { splitToMidis, MusicXmlValidationError } from '../src/pipeline/splitParts';
import { midiPathFor, VOICES, WORK_ROOT } from '../src/utils/paths';
import { parseMidiFile, noteOnNames } from './helpers/midiDecode';
import { buildMxlBuffer } from './helpers/buildMxl';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const OPEN_FIXTURE = path.join(FIXTURES, 'satb-sample.xml');
const CLOSED_FIXTURE = path.join(FIXTURES, 'satb-closed-score.xml');

/** Job IDs used in this file, cleaned up afterEach. */
const createdJobIds = new Set<string>();

function jobId(suffix: string): string {
  const id = `test-${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdJobIds.add(id);
  return id;
}

afterEach(() => {
  for (const id of createdJobIds) {
    const dir = path.join(WORK_ROOT, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  createdJobIds.clear();
});

/** Write `text` to a tmp file with the given extension and return the path. */
function writeTmp(text: string | Buffer, ext: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'choirflow-test-'));
  const p = path.join(dir, `score${ext}`);
  fs.writeFileSync(p, text);
  return p;
}

describe('splitToMidis – open score (4 parts)', () => {
  it('produces 4 MIDI files with the expected pitch sequences', async () => {
    const id = jobId('open');
    const result = await splitToMidis(id, OPEN_FIXTURE);

    expect(result.tempo).toBe(100);
    expect(result.partNames).toHaveLength(4);

    // All 4 voice files exist on disk.
    for (const v of VOICES) {
      const p = midiPathFor(id, v);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(0);
    }

    // Pitch sequences hand-verified from the fixture's authored content.
    const sop = noteOnNames(parseMidiFile(midiPathFor(id, 'soprano')));
    const alt = noteOnNames(parseMidiFile(midiPathFor(id, 'alto')));
    const ten = noteOnNames(parseMidiFile(midiPathFor(id, 'tenor')));
    const bas = noteOnNames(parseMidiFile(midiPathFor(id, 'bass')));

    expect(sop).toEqual(['C5', 'D5', 'E5', 'F5', 'E5', 'D5', 'C5']);
    expect(alt).toEqual(['G4', 'G4', 'G4', 'A4', 'G4', 'G4', 'G4']);
    expect(ten).toEqual(['E4', 'D4', 'C4', 'C4', 'C4', 'B3', 'C4']);
    expect(bas).toEqual(['C3', 'B2', 'A2', 'F2', 'C3', 'G2', 'C3']);
  });

  it('writes MIDI with ppq = 128', async () => {
    const id = jobId('open-ppq');
    await splitToMidis(id, OPEN_FIXTURE);
    const parsed = parseMidiFile(midiPathFor(id, 'soprano'));
    expect(parsed.ppq).toBe(128);
  });
});

describe('splitToMidis – closed score (2 parts)', () => {
  it('splits treble into S/A and bass into T/B with correct pitches', async () => {
    const id = jobId('closed');
    const result = await splitToMidis(id, CLOSED_FIXTURE);

    expect(result.tempo).toBe(120);

    const sop = noteOnNames(parseMidiFile(midiPathFor(id, 'soprano')));
    const alt = noteOnNames(parseMidiFile(midiPathFor(id, 'alto')));
    const ten = noteOnNames(parseMidiFile(midiPathFor(id, 'tenor')));
    const bas = noteOnNames(parseMidiFile(midiPathFor(id, 'bass')));

    // Hand-verified expected output. See compressed history (b1) for derivation.
    expect(sop).toEqual(['F4', 'F4', 'F4']);
    expect(alt).toEqual(['D4', 'C4', 'F4']);
    expect(ten).toEqual(['F3', 'A3', 'F3']);
    expect(bas).toEqual(['A#2', 'F3', 'F3']);
  });
});

describe('splitToMidis – .mxl (compressed) input', () => {
  it('produces byte-identical MIDIs whether read from .xml or .mxl', async () => {
    const xmlText = fs.readFileSync(OPEN_FIXTURE, 'utf-8');
    const mxlBuf = buildMxlBuffer(xmlText, 'satb-sample.xml');
    const mxlPath = writeTmp(mxlBuf, '.mxl');

    const xmlId = jobId('mxl-xml');
    const mxlId = jobId('mxl-mxl');
    await splitToMidis(xmlId, OPEN_FIXTURE);
    await splitToMidis(mxlId, mxlPath);

    for (const v of VOICES) {
      const a = fs.readFileSync(midiPathFor(xmlId, v));
      const b = fs.readFileSync(midiPathFor(mxlId, v));
      expect(b.equals(a)).toBe(true);
    }
  });
});

describe('splitToMidis – validation errors', () => {
  it('throws MusicXmlValidationError for an empty file', async () => {
    const p = writeTmp('', '.xml');
    const id = jobId('empty');
    await expect(splitToMidis(id, p)).rejects.toBeInstanceOf(MusicXmlValidationError);
  });

  it('throws MusicXmlValidationError for non-XML content', async () => {
    const p = writeTmp('this is just plain text, not XML', '.xml');
    const id = jobId('nonxml');
    await expect(splitToMidis(id, p)).rejects.toBeInstanceOf(MusicXmlValidationError);
  });

  it('throws MusicXmlValidationError for XML whose root is not <score-partwise>', async () => {
    const p = writeTmp('<?xml version="1.0"?><html><body/></html>', '.xml');
    const id = jobId('wrongroot');
    await expect(splitToMidis(id, p)).rejects.toThrow(MusicXmlValidationError);
  });

  it('throws MusicXmlValidationError for <score-timewise>', async () => {
    const p = writeTmp(
      '<?xml version="1.0"?><score-timewise><measure number="1"/></score-timewise>',
      '.xml',
    );
    const id = jobId('timewise');
    await expect(splitToMidis(id, p)).rejects.toThrow(/score-timewise/i);
  });

  it('throws with SAT diagnosis when 3 parts named S/A/T (no bass)', async () => {
    const xml =
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      '<score-part id="P1"><part-name>Soprano</part-name></score-part>' +
      '<score-part id="P2"><part-name>Alto</part-name></score-part>' +
      '<score-part id="P3"><part-name>Tenor</part-name></score-part>' +
      '</part-list>' +
      '<part id="P1"><measure number="1"><note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P2"><measure number="1"><note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P3"><measure number="1"><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '</score-partwise>';
    const p = writeTmp(xml, '.xml');
    const id = jobId('threeparts-sat');
    await expect(splitToMidis(id, p)).rejects.toThrow(/SAT.*missing.*bass/i);
  });

  it('throws with SAB diagnosis when 3 parts named S/A/B (no tenor)', async () => {
    const xml =
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      '<score-part id="P1"><part-name>Soprano</part-name></score-part>' +
      '<score-part id="P2"><part-name>Alto</part-name></score-part>' +
      '<score-part id="P3"><part-name>Bass</part-name></score-part>' +
      '</part-list>' +
      '<part id="P1"><measure number="1"><note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P2"><measure number="1"><note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P3"><measure number="1"><note><pitch><step>E</step><octave>3</octave></pitch><duration>1</duration></note></measure></part>' +
      '</score-partwise>';
    const p = writeTmp(xml, '.xml');
    const id = jobId('threeparts-sab');
    await expect(splitToMidis(id, p)).rejects.toThrow(/SAB.*no tenor|tenor.*not yet/i);
  });

  it('throws with generic listing when part count is unusual (5 parts)', async () => {
      const xml =
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      '<score-part id="P1"><part-name>Flute</part-name></score-part>' +
      '<score-part id="P2"><part-name>Oboe</part-name></score-part>' +
      '<score-part id="P3"><part-name>Clarinet</part-name></score-part>' +
      '<score-part id="P4"><part-name>Horn</part-name></score-part>' +
      '<score-part id="P5"><part-name>Bassoon</part-name></score-part>' +
      '</part-list>' +
      '<part id="P1"><measure number="1"><note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P2"><measure number="1"><note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P3"><measure number="1"><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P4"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P5"><measure number="1"><note><pitch><step>F</step><octave>3</octave></pitch><duration>1</duration></note></measure></part>' +
      '</score-partwise>';
    const p = writeTmp(xml, '.xml');
    const id = jobId('fiveparts');
    await expect(splitToMidis(id, p)).rejects.toThrow(/found 5 parts.*Flute.*Oboe/);
  });

  it('throws when only 1 vocal part remains after piano-like parts are filtered out', async () => {
    // 1 vocal + 1 piano: vocal count = 1, which is not a supported SATB shape.
    const xml =
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      '<score-part id="P1"><part-name>Voice</part-name></score-part>' +
      '<score-part id="P2"><part-name>Piano</part-name></score-part>' +
      '</part-list>' +
      '<part id="P1"><measure number="1"><note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P2"><measure number="1"><attributes><staves>2</staves></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '</score-partwise>';
    const p = writeTmp(xml, '.xml');
    const id = jobId('onevocal-piano');
    await expect(splitToMidis(id, p)).rejects.toThrow(/piano accompaniment.*not.*standard SATB/i);
  });
});

describe('splitToMidis – vocal + piano accompaniment', () => {
  /**
   * Build a MusicXML score with `vocalParts` single-staff vocal parts followed
   * by a 2-staff piano part. The piano is in a different pitch register (C2)
   * so we can verify those pitches do NOT appear in the SATB output.
   */
  function vocalPlusPianoXml(vocalPitches: { step: string; octave: number; name: string }[]): string {
    const vocalPartsXml = vocalPitches
      .map(
        (v, i) =>
          `<part id="P${i + 1}"><measure number="1">` +
          `<attributes><divisions>1</divisions></attributes>` +
          `<note><pitch><step>${v.step}</step><octave>${v.octave}</octave></pitch><duration>1</duration></note>` +
          `</measure></part>`,
      )
      .join('');

    const pianoId = `P${vocalPitches.length + 1}`;
    // Piano grand staff: <staves>2</staves>, with notes on staff 1 (C2) and staff 2 (C2).
    const pianoXml =
      `<part id="${pianoId}"><measure number="1">` +
      `<attributes><divisions>1</divisions><staves>2</staves></attributes>` +
      `<note><pitch><step>C</step><octave>2</octave></pitch><duration>1</duration><staff>1</staff></note>` +
      `<backup><duration>1</duration></backup>` +
      `<note><pitch><step>C</step><octave>2</octave></pitch><duration>1</duration><staff>2</staff></note>` +
      `</measure></part>`;

    const scoreParts = vocalPitches
      .map((v, i) => `<score-part id="P${i + 1}"><part-name>${v.name}</part-name></score-part>`)
      .join('');

    return (
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      scoreParts +
      `<score-part id="${pianoId}"><part-name>Piano</part-name></score-part>` +
      '</part-list>' +
      vocalPartsXml +
      pianoXml +
      '</score-partwise>'
    );
  }

  it('renders 4 vocal parts + piano as open-score SATB, dropping the piano', async () => {
    const xml = vocalPlusPianoXml([
      { step: 'C', octave: 5, name: 'Soprano' },
      { step: 'G', octave: 4, name: 'Alto' },
      { step: 'E', octave: 4, name: 'Tenor' },
      { step: 'C', octave: 4, name: 'Bass' },
    ]);
    const p = writeTmp(xml, '.xml');
    const id = jobId('open-piano');

    const result = await splitToMidis(id, p);

    // partNames in result reflect only the vocal parts (piano dropped).
    expect(result.partNames).toEqual(['soprano', 'alto', 'tenor', 'bass']);

    const sop = noteOnNames(parseMidiFile(midiPathFor(id, 'soprano')));
    const alt = noteOnNames(parseMidiFile(midiPathFor(id, 'alto')));
    const ten = noteOnNames(parseMidiFile(midiPathFor(id, 'tenor')));
    const bas = noteOnNames(parseMidiFile(midiPathFor(id, 'bass')));

    expect(sop).toEqual(['C5']);
    expect(alt).toEqual(['G4']);
    expect(ten).toEqual(['E4']);
    expect(bas).toEqual(['C4']);

    // Piano was at C2 — confirm none of the SATB tracks contain that pitch.
    for (const v of VOICES) {
      const notes = noteOnNames(parseMidiFile(midiPathFor(id, v)));
      expect(notes).not.toContain('C2');
    }
  });

  it('renders 2 vocal parts + piano as closed-score SATB, dropping the piano', async () => {
    // Two vocal parts with explicit clefs: treble (S+A) and bass (T+B). Each part
    // has one chord (two pitches) to exercise the chord-pair voice split.
    const xml =
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      '<score-part id="P1"><part-name>Women</part-name></score-part>' +
      '<score-part id="P2"><part-name>Men</part-name></score-part>' +
      '<score-part id="P3"><part-name>Piano</part-name></score-part>' +
      '</part-list>' +
      // Treble staff: C5 (S) over G4 (A).
      '<part id="P1"><measure number="1">' +
      '<attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>' +
      '<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration></note>' +
      '<note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note>' +
      '</measure></part>' +
      // Bass staff: E4 (T) over C4 (B). (Tenor written at sounding pitch for simplicity.)
      '<part id="P2"><measure number="1">' +
      '<attributes><divisions>1</divisions><clef><sign>F</sign><line>4</line></clef></attributes>' +
      '<note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note>' +
      '<note><chord/><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>' +
      '</measure></part>' +
      // Piano part (2 staves) — should be dropped.
      '<part id="P3"><measure number="1">' +
      '<attributes><divisions>1</divisions><staves>2</staves></attributes>' +
      '<note><pitch><step>C</step><octave>2</octave></pitch><duration>1</duration><staff>1</staff></note>' +
      '<backup><duration>1</duration></backup>' +
      '<note><pitch><step>C</step><octave>2</octave></pitch><duration>1</duration><staff>2</staff></note>' +
      '</measure></part>' +
      '</score-partwise>';

    const p = writeTmp(xml, '.xml');
    const id = jobId('closed-piano');

    const result = await splitToMidis(id, p);

    expect(result.partNames).toEqual(['women', 'men']);

    const sop = noteOnNames(parseMidiFile(midiPathFor(id, 'soprano')));
    const alt = noteOnNames(parseMidiFile(midiPathFor(id, 'alto')));
    const ten = noteOnNames(parseMidiFile(midiPathFor(id, 'tenor')));
    const bas = noteOnNames(parseMidiFile(midiPathFor(id, 'bass')));

    expect(sop).toEqual(['C5']);
    expect(alt).toEqual(['G4']);
    expect(ten).toEqual(['E4']);
    expect(bas).toEqual(['C4']);

    // Piano C2 must not leak in.
    for (const v of VOICES) {
      const notes = noteOnNames(parseMidiFile(midiPathFor(id, v)));
      expect(notes).not.toContain('C2');
    }
  });

  it('detects a part as piano via <staves>2</staves> even when not named "piano"', async () => {
    // 4 vocal parts + 1 unnamed 2-staff part. The unnamed part should be
    // classified as piano-like (via staff count) and dropped, leaving open4.
    const xml =
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      '<score-part id="P1"><part-name>Soprano</part-name></score-part>' +
      '<score-part id="P2"><part-name>Alto</part-name></score-part>' +
      '<score-part id="P3"><part-name>Tenor</part-name></score-part>' +
      '<score-part id="P4"><part-name>Bass</part-name></score-part>' +
      '<score-part id="P5"><part-name>Reduction</part-name></score-part>' +
      '</part-list>' +
      '<part id="P1"><measure number="1"><note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P2"><measure number="1"><note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P3"><measure number="1"><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P4"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P5"><measure number="1">' +
      '<attributes><divisions>1</divisions><staves>2</staves></attributes>' +
      '<note><pitch><step>C</step><octave>2</octave></pitch><duration>1</duration><staff>1</staff></note>' +
      '<backup><duration>1</duration></backup>' +
      '<note><pitch><step>C</step><octave>2</octave></pitch><duration>1</duration><staff>2</staff></note>' +
      '</measure></part>' +
      '</score-partwise>';
    const p = writeTmp(xml, '.xml');
    const id = jobId('open-unnamed-piano');

    await splitToMidis(id, p);
    const sop = noteOnNames(parseMidiFile(midiPathFor(id, 'soprano')));
    expect(sop).toEqual(['C5']);
    expect(noteOnNames(parseMidiFile(midiPathFor(id, 'bass')))).toEqual(['C4']);
  });
});

describe('splitToMidis – tie merging', () => {
  /**
   * Build a 4-part open-score where each part holds a single pitch for the
   * given number of half-note `<note>` elements. If `tieAll` is true, every
   * note except the last carries `<tie type="start"/>` and every note except
   * the first carries `<tie type="stop"/>` — i.e. a single sustained note
   * chained across `count` halves.
   */
  function tiedHalvesXml(parts: Array<{ name: string; step: string; octave: number }>, count: number, tieAll: boolean): string {
    const partList = parts
      .map((p, i) => `<score-part id="P${i + 1}"><part-name>${p.name}</part-name></score-part>`)
      .join('');
    const partBodies = parts
      .map((p, i) => {
        let notes = '';
        for (let n = 0; n < count; n++) {
          const ties: string[] = [];
          if (tieAll && n < count - 1) ties.push('<tie type="start"/>');
          if (tieAll && n > 0) ties.push('<tie type="stop"/>');
          notes += `<note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>2</duration>${ties.join('')}</note>`;
        }
        return (
          `<part id="P${i + 1}"><measure number="1">` +
          `<attributes><divisions>1</divisions></attributes>` +
          notes +
          `</measure></part>`
        );
      })
      .join('');
    return `<?xml version="1.0"?><score-partwise><part-list>${partList}</part-list>${partBodies}</score-partwise>`;
  }

  /** Returns the duration in MIDI ticks of the first note-on/note-off pair. */
  function firstNoteDuration(filePath: string): number {
    const parsed = parseMidiFile(filePath);
    const on = parsed.events.find((e) => e.type === 'on');
    if (!on) throw new Error('no note-on in file');
    const off = parsed.events.find((e) => e.type === 'off' && e.pitch === on.pitch && e.tick > on.tick);
    if (!off) throw new Error('no matching note-off');
    return off.tick - on.tick;
  }

  // Default articulation gap is 30 ms; at 120 BPM with 128 ppq that's
  // round(30 / 1000 * 120 / 60 * 128) = 8 ticks trimmed off the note-off
  // of every pitched note. Tests below expect (raw_duration − ARTIC_GAP).
  // The trimmed time becomes silence before the *next* event, so total
  // elapsed time is preserved — but a tie chain collapses to one note, so
  // its single trim is observable in its note-off position.
  const ARTIC_GAP = 8;

  it('merges two same-pitch notes connected by <tie> into a single sustained note', async () => {
    // 2 half notes (duration=2 with divisions=1 ⇒ 2 quarters each = 256 ticks each),
    // tied together. After merge: one note of 512 ticks. Before: two notes of 256.
    const xml = tiedHalvesXml(
      [
        { name: 'Soprano', step: 'C', octave: 5 },
        { name: 'Alto', step: 'G', octave: 4 },
        { name: 'Tenor', step: 'E', octave: 4 },
        { name: 'Bass', step: 'C', octave: 4 },
      ],
      2,
      true,
    );
    const p = writeTmp(xml, '.xml');
    const id = jobId('tie-pair');
    await splitToMidis(id, p);

    for (const v of VOICES) {
      const parsed = parseMidiFile(midiPathFor(id, v));
      const ons = parsed.events.filter((e) => e.type === 'on');
      expect(ons).toHaveLength(1); // merged into one note
      expect(firstNoteDuration(midiPathFor(id, v))).toBe(512 - ARTIC_GAP); // 2 × 256 − gap
    }
  });

  it('collapses a 3-note tie chain (start, start+stop, stop) into one note', async () => {
    const xml = tiedHalvesXml([{ name: 'Soprano', step: 'A', octave: 4 }], 3, true);
    const p = writeTmp(xml, '.xml');
    const id = jobId('tie-chain');
    // Score is 1 part — not valid SATB, just verifying the parser through
    // open-score path requires 4 parts. So pad with 3 dummy parts.
    const xml4 = tiedHalvesXml(
      [
        { name: 'Soprano', step: 'A', octave: 4 },
        { name: 'Alto', step: 'A', octave: 4 },
        { name: 'Tenor', step: 'A', octave: 3 },
        { name: 'Bass', step: 'A', octave: 3 },
      ],
      3,
      true,
    );
    const p4 = writeTmp(xml4, '.xml');
    const id4 = jobId('tie-chain-4');
    await splitToMidis(id4, p4);
    for (const v of VOICES) {
      const parsed = parseMidiFile(midiPathFor(id4, v));
      const ons = parsed.events.filter((e) => e.type === 'on');
      expect(ons).toHaveLength(1);
      expect(firstNoteDuration(midiPathFor(id4, v))).toBe(768 - ARTIC_GAP); // 3 × 256 − gap
    }
    // Avoid unused warnings in case the lone-part variant is needed later.
    void p;
    void id;
  });

  it('merges ties that cross a barline', async () => {
    // Two measures, each with one half note (duration=2, divisions=1). The
    // first carries <tie type="start"/>, the second <tie type="stop"/>.
    const measure = (tie: string, step: string, octave: number) =>
      `<measure number="1">` +
      `<attributes><divisions>1</divisions></attributes>` +
      `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>2</duration>${tie}</note>` +
      `</measure>`;
    const partXml = (id: string, step: string, octave: number) =>
      `<part id="${id}">${measure('<tie type="start"/>', step, octave)}${measure('<tie type="stop"/>', step, octave)}</part>`;
    const xml =
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      '<score-part id="P1"><part-name>Soprano</part-name></score-part>' +
      '<score-part id="P2"><part-name>Alto</part-name></score-part>' +
      '<score-part id="P3"><part-name>Tenor</part-name></score-part>' +
      '<score-part id="P4"><part-name>Bass</part-name></score-part>' +
      '</part-list>' +
      partXml('P1', 'C', 5) +
      partXml('P2', 'G', 4) +
      partXml('P3', 'E', 4) +
      partXml('P4', 'C', 4) +
      '</score-partwise>';
    const p = writeTmp(xml, '.xml');
    const id = jobId('tie-barline');
    await splitToMidis(id, p);

    const sop = parseMidiFile(midiPathFor(id, 'soprano'));
    const ons = sop.events.filter((e) => e.type === 'on');
    expect(ons).toHaveLength(1);
    expect(firstNoteDuration(midiPathFor(id, 'soprano'))).toBe(512 - ARTIC_GAP);
  });

  it('does not merge across different pitches (defensive)', async () => {
    // Same XML structure as tied test, but with mismatched pitches across the
    // two notes. Even if the first carries <tie type="start"/>, the second
    // has a different pitch and the tie chain stops without absorbing it.
    const tiedDifferentPitch = (id: string, step1: string, step2: string, octave: number) =>
      `<part id="${id}"><measure number="1">` +
      `<attributes><divisions>1</divisions></attributes>` +
      `<note><pitch><step>${step1}</step><octave>${octave}</octave></pitch><duration>2</duration><tie type="start"/></note>` +
      `<note><pitch><step>${step2}</step><octave>${octave}</octave></pitch><duration>2</duration></note>` +
      `</measure></part>`;
    const xml =
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      '<score-part id="P1"><part-name>Soprano</part-name></score-part>' +
      '<score-part id="P2"><part-name>Alto</part-name></score-part>' +
      '<score-part id="P3"><part-name>Tenor</part-name></score-part>' +
      '<score-part id="P4"><part-name>Bass</part-name></score-part>' +
      '</part-list>' +
      tiedDifferentPitch('P1', 'C', 'D', 5) +
      tiedDifferentPitch('P2', 'G', 'A', 4) +
      tiedDifferentPitch('P3', 'E', 'F', 4) +
      tiedDifferentPitch('P4', 'C', 'D', 4) +
      '</score-partwise>';
    const p = writeTmp(xml, '.xml');
    const id = jobId('tie-mismatched');
    await splitToMidis(id, p);

    const sop = parseMidiFile(midiPathFor(id, 'soprano'));
    const ons = sop.events.filter((e) => e.type === 'on');
    // Two distinct notes — no merging.
    expect(ons).toHaveLength(2);
    expect(noteOnNames(sop)).toEqual(['C5', 'D5']);
  });
});

describe('splitToMidis – tempo detection', () => {
  /**
   * Build a minimal 4-part open score where the first measure of part 1
   * contains the caller-supplied `firstMeasureExtras` (typically a
   * `<direction>` or `<sound>` block). Each part holds one quarter note so
   * splitToMidis has something to render and we can read back result.tempo.
   */
  function tempoXml(firstMeasureExtras: string): string {
    const partBody = (id: string, step: string, octave: number, extras: string) =>
      `<part id="${id}"><measure number="1">` +
      `<attributes><divisions>1</divisions></attributes>` +
      extras +
      `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>1</duration></note>` +
      `</measure></part>`;
    return (
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      '<score-part id="P1"><part-name>Soprano</part-name></score-part>' +
      '<score-part id="P2"><part-name>Alto</part-name></score-part>' +
      '<score-part id="P3"><part-name>Tenor</part-name></score-part>' +
      '<score-part id="P4"><part-name>Bass</part-name></score-part>' +
      '</part-list>' +
      partBody('P1', 'C', 5, firstMeasureExtras) +
      partBody('P2', 'G', 4, '') +
      partBody('P3', 'E', 4, '') +
      partBody('P4', 'C', 4, '') +
      '</score-partwise>'
    );
  }

  it('reads <sound tempo> nested inside <direction> (standard MusicXML location)', async () => {
    const extras =
      '<direction placement="above"><direction-type>' +
      '<metronome><beat-unit>quarter</beat-unit><per-minute>76</per-minute></metronome>' +
      '</direction-type><sound tempo="76"/></direction>';
    const xml = tempoXml(extras);
    const p = writeTmp(xml, '.xml');
    const id = jobId('tempo-direction-sound');
    const result = await splitToMidis(id, p);
    expect(result.tempo).toBe(76);
  });

  it('still reads <sound tempo> placed directly under <measure>', async () => {
    const xml = tempoXml('<sound tempo="92"/>');
    const p = writeTmp(xml, '.xml');
    const id = jobId('tempo-measure-sound');
    const result = await splitToMidis(id, p);
    expect(result.tempo).toBe(92);
  });

  it('derives BPM from a <metronome> mark when no <sound tempo> is present', async () => {
    // "quarter = 84" with no playback-tempo sibling.
    const extras =
      '<direction placement="above"><direction-type>' +
      '<metronome><beat-unit>quarter</beat-unit><per-minute>84</per-minute></metronome>' +
      '</direction-type></direction>';
    const xml = tempoXml(extras);
    const p = writeTmp(xml, '.xml');
    const id = jobId('tempo-metronome-quarter');
    const result = await splitToMidis(id, p);
    expect(result.tempo).toBe(84);
  });

  it('scales BPM correctly when the metronome beat unit is not a quarter', async () => {
    // "half = 60" ⇒ a half note per second ⇒ 120 quarter-BPM.
    const extras =
      '<direction><direction-type>' +
      '<metronome><beat-unit>half</beat-unit><per-minute>60</per-minute></metronome>' +
      '</direction-type></direction>';
    const xml = tempoXml(extras);
    const p = writeTmp(xml, '.xml');
    const id = jobId('tempo-metronome-half');
    const result = await splitToMidis(id, p);
    expect(result.tempo).toBe(120);
  });

  it('honours <beat-unit-dot/> on metronome marks (dotted-quarter = 90 ⇒ 135 quarter-BPM)', async () => {
    // Dotted quarter = 1.5 quarter notes; per-minute 90 ⇒ 135 quarter-BPM.
    const extras =
      '<direction><direction-type>' +
      '<metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>90</per-minute></metronome>' +
      '</direction-type></direction>';
    const xml = tempoXml(extras);
    const p = writeTmp(xml, '.xml');
    const id = jobId('tempo-metronome-dotted');
    const result = await splitToMidis(id, p);
    expect(result.tempo).toBe(135);
  });

  it('prefers an explicit <sound tempo> over a <metronome> mark anywhere in the score', async () => {
    // Visible metronome says 60 but playback tempo says 100 — playback wins.
    const extras =
      '<direction><direction-type>' +
      '<metronome><beat-unit>quarter</beat-unit><per-minute>60</per-minute></metronome>' +
      '</direction-type><sound tempo="100"/></direction>';
    const xml = tempoXml(extras);
    const p = writeTmp(xml, '.xml');
    const id = jobId('tempo-sound-wins');
    const result = await splitToMidis(id, p);
    expect(result.tempo).toBe(100);
  });

  it('falls back to 120 BPM when the score has no tempo information at all', async () => {
    const xml = tempoXml('');
    const p = writeTmp(xml, '.xml');
    const id = jobId('tempo-default');
    const result = await splitToMidis(id, p);
    expect(result.tempo).toBe(120);
  });
});

describe('splitToMidis – articulation gap between consecutive notes', () => {
  // At the default 30 ms gap and the default 120 BPM (no <sound tempo> in
  // these fixtures), every pitched note is trimmed by 8 ticks: the freed
  // ticks become silence before the next note. Tests pin this exact value
  // so any change to the default is caught here intentionally.
  const ARTIC_GAP = 8;

  /** Four-part XML with each part holding `count` quarter notes of one pitch. */
  function quartersXml(
    parts: Array<{ name: string; step: string; octave: number }>,
    count: number,
  ): string {
    const partList = parts
      .map((p, i) => `<score-part id="P${i + 1}"><part-name>${p.name}</part-name></score-part>`)
      .join('');
    const partBodies = parts
      .map((p, i) => {
        let notes = '';
        for (let n = 0; n < count; n++) {
          notes += `<note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>1</duration></note>`;
        }
        return (
          `<part id="P${i + 1}"><measure number="1">` +
          `<attributes><divisions>1</divisions></attributes>` +
          notes +
          `</measure></part>`
        );
      })
      .join('');
    return `<?xml version="1.0"?><score-partwise><part-list>${partList}</part-list>${partBodies}</score-partwise>`;
  }

  it('inserts a silent gap between two consecutive same-pitch notes', async () => {
    // Two quarter notes (divisions=1 ⇒ 128 ticks each) on the same pitch.
    // Without a gap, note-off of #1 = note-on of #2 = tick 128. With the
    // gap, note-off of #1 = 128 − 8 = 120, and note-on of #2 is still 128.
    const xml = quartersXml(
      [
        { name: 'Soprano', step: 'C', octave: 5 },
        { name: 'Alto', step: 'G', octave: 4 },
        { name: 'Tenor', step: 'E', octave: 4 },
        { name: 'Bass', step: 'C', octave: 4 },
      ],
      2,
    );
    const p = writeTmp(xml, '.xml');
    const id = jobId('artic-pair');
    await splitToMidis(id, p);

    const sop = parseMidiFile(midiPathFor(id, 'soprano'));
    const ons = sop.events.filter((e) => e.type === 'on');
    const offs = sop.events.filter((e) => e.type === 'off');
    expect(ons).toHaveLength(2);
    expect(offs).toHaveLength(2);

    // Total elapsed time across the two notes is preserved.
    expect(ons[0].tick).toBe(0);
    expect(ons[1].tick).toBe(128);

    // First note is trimmed; the gap lands between the off and the next on.
    expect(offs[0].tick).toBe(128 - ARTIC_GAP);
    expect(ons[1].tick - offs[0].tick).toBe(ARTIC_GAP);
  });

  it('applies the gap uniformly across a longer run of notes', async () => {
    // Four quarter notes ⇒ four trims, all of equal size; the trim of note N
    // is absorbed into a wait before note N+1, so each note-on remains on its
    // original tick (0, 128, 256, 384) and the gap is always 8 ticks wide.
    const xml = quartersXml(
      [
        { name: 'Soprano', step: 'C', octave: 5 },
        { name: 'Alto', step: 'G', octave: 4 },
        { name: 'Tenor', step: 'E', octave: 4 },
        { name: 'Bass', step: 'C', octave: 4 },
      ],
      4,
    );
    const p = writeTmp(xml, '.xml');
    const id = jobId('artic-run');
    await splitToMidis(id, p);

    const sop = parseMidiFile(midiPathFor(id, 'soprano'));
    const ons = sop.events.filter((e) => e.type === 'on').map((e) => e.tick);
    const offs = sop.events.filter((e) => e.type === 'off').map((e) => e.tick);
    expect(ons).toEqual([0, 128, 256, 384]);
    expect(offs).toEqual([128 - ARTIC_GAP, 256 - ARTIC_GAP, 384 - ARTIC_GAP, 512 - ARTIC_GAP]);
  });

  it('trims the final note too — its note-off comes before the track end', async () => {
    // Verifies that the gap isn't conditioned on a "next note exists" check;
    // the final note simply has a tiny silent tail (harmless).
    const xml = quartersXml(
      [
        { name: 'Soprano', step: 'C', octave: 5 },
        { name: 'Alto', step: 'G', octave: 4 },
        { name: 'Tenor', step: 'E', octave: 4 },
        { name: 'Bass', step: 'C', octave: 4 },
      ],
      1,
    );
    const p = writeTmp(xml, '.xml');
    const id = jobId('artic-final');
    await splitToMidis(id, p);

    const sop = parseMidiFile(midiPathFor(id, 'soprano'));
    const ons = sop.events.filter((e) => e.type === 'on');
    const offs = sop.events.filter((e) => e.type === 'off');
    expect(ons).toHaveLength(1);
    expect(offs).toHaveLength(1);
    expect(offs[0].tick).toBe(128 - ARTIC_GAP);
  });

  it('never trims a note below 1 tick (defensive for very short notes)', async () => {
    // Build a part containing a note with duration=1 against divisions=128
    // ⇒ ticks = round(1/128 * 128) = 1 tick — shorter than the 8-tick gap.
    // The note should still produce a note-on / note-off pair, with the
    // off at least 1 tick after the on. (We don't care exactly where; only
    // that the note isn't silently dropped to zero length.)
    const xml =
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      '<score-part id="P1"><part-name>Soprano</part-name></score-part>' +
      '<score-part id="P2"><part-name>Alto</part-name></score-part>' +
      '<score-part id="P3"><part-name>Tenor</part-name></score-part>' +
      '<score-part id="P4"><part-name>Bass</part-name></score-part>' +
      '</part-list>' +
      '<part id="P1"><measure number="1">' +
      '<attributes><divisions>128</divisions></attributes>' +
      '<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration></note>' +
      '<note><pitch><step>D</step><octave>5</octave></pitch><duration>128</duration></note>' +
      '</measure></part>' +
      '<part id="P2"><measure number="1"><attributes><divisions>128</divisions></attributes>' +
      '<note><pitch><step>G</step><octave>4</octave></pitch><duration>128</duration></note></measure></part>' +
      '<part id="P3"><measure number="1"><attributes><divisions>128</divisions></attributes>' +
      '<note><pitch><step>E</step><octave>4</octave></pitch><duration>128</duration></note></measure></part>' +
      '<part id="P4"><measure number="1"><attributes><divisions>128</divisions></attributes>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>128</duration></note></measure></part>' +
      '</score-partwise>';
    const p = writeTmp(xml, '.xml');
    const id = jobId('artic-min-tick');
    await splitToMidis(id, p);

    const sop = parseMidiFile(midiPathFor(id, 'soprano'));
    const firstOn = sop.events.find((e) => e.type === 'on');
    const firstOff = sop.events.find((e) => e.type === 'off' && e.pitch === firstOn?.pitch);
    expect(firstOn).toBeDefined();
    expect(firstOff).toBeDefined();
    // The 1-tick note still has at least 1 tick between on and off.
    expect(firstOff!.tick - firstOn!.tick).toBeGreaterThanOrEqual(1);
  });
});

describe('splitToMidis – leading-silence trim across all voices', () => {
  // Default articulation gap = 8 ticks at 120 BPM / 128 ppq (same as the
  // articulation-gap describe block above). The trim shaves the *common*
  // leading silence; the articulation gap still applies on top of any
  // notes that follow.
  const ARTIC_GAP = 8;

  /**
   * Four-part XML where each part is composed of `leadingRestQuarters`
   * quarter rests followed by `noteQuarters` quarter notes of one pitch.
   * Divisions=1 → 128 ticks per quarter.
   */
  function withLeadingRestsXml(
    parts: Array<{
      name: string;
      step: string;
      octave: number;
      leadingRestQuarters: number;
      noteQuarters: number;
    }>,
  ): string {
    const partList = parts
      .map((p, i) => `<score-part id="P${i + 1}"><part-name>${p.name}</part-name></score-part>`)
      .join('');
    const partBodies = parts
      .map((p, i) => {
        let body = `<attributes><divisions>1</divisions></attributes>`;
        for (let n = 0; n < p.leadingRestQuarters; n++) {
          body += `<note><rest/><duration>1</duration></note>`;
        }
        for (let n = 0; n < p.noteQuarters; n++) {
          body += `<note><pitch><step>${p.step}</step><octave>${p.octave}</octave></pitch><duration>1</duration></note>`;
        }
        return `<part id="P${i + 1}"><measure number="1">${body}</measure></part>`;
      })
      .join('');
    return `<?xml version="1.0"?><score-partwise><part-list>${partList}</part-list>${partBodies}</score-partwise>`;
  }

  /**
   * Tick of the first note-on in a MIDI file. Throws if the file has no
   * note-on events — caller should only use this on voices with notes.
   */
  function firstNoteOnTick(filePath: string): number {
    const m = parseMidiFile(filePath);
    const on = m.events.find((e) => e.type === 'on');
    if (!on) throw new Error(`no note-on found in ${filePath}`);
    return on.tick;
  }

  it('shifts a late-entering voice to start at t=0 when all voices share leading rests', async () => {
    // Soprano enters at the start. Alto/Tenor/Bass each wait 4 quarter notes
    // (4 * 128 = 512 ticks). Soprano's leading rest = 0, so the common trim
    // is 0 ticks. After trim, Soprano starts at 0, and ATB still start at
    // 512 ticks (their offset is preserved).
    const xml = withLeadingRestsXml([
      { name: 'Soprano', step: 'C', octave: 5, leadingRestQuarters: 0, noteQuarters: 8 },
      { name: 'Alto', step: 'G', octave: 4, leadingRestQuarters: 4, noteQuarters: 4 },
      { name: 'Tenor', step: 'E', octave: 4, leadingRestQuarters: 4, noteQuarters: 4 },
      { name: 'Bass', step: 'C', octave: 4, leadingRestQuarters: 4, noteQuarters: 4 },
    ]);
    const p = writeTmp(xml, '.xml');
    const id = jobId('trim-shared-zero');
    await splitToMidis(id, p);

    expect(firstNoteOnTick(midiPathFor(id, 'soprano'))).toBe(0);
    expect(firstNoteOnTick(midiPathFor(id, 'alto'))).toBe(512);
    expect(firstNoteOnTick(midiPathFor(id, 'tenor'))).toBe(512);
    expect(firstNoteOnTick(midiPathFor(id, 'bass'))).toBe(512);
  });

  it('trims a leading silence shared by ALL voices so the piece starts at t=0', async () => {
    // All four voices have 2 quarter rests (256 ticks) before their first
    // note. The common trim is 256 ticks. After trim every voice's first
    // note-on lands at tick 0.
    const xml = withLeadingRestsXml([
      { name: 'Soprano', step: 'C', octave: 5, leadingRestQuarters: 2, noteQuarters: 4 },
      { name: 'Alto', step: 'G', octave: 4, leadingRestQuarters: 2, noteQuarters: 4 },
      { name: 'Tenor', step: 'E', octave: 4, leadingRestQuarters: 2, noteQuarters: 4 },
      { name: 'Bass', step: 'C', octave: 4, leadingRestQuarters: 2, noteQuarters: 4 },
    ]);
    const p = writeTmp(xml, '.xml');
    const id = jobId('trim-all');
    await splitToMidis(id, p);

    for (const v of VOICES) {
      expect(firstNoteOnTick(midiPathFor(id, v))).toBe(0);
    }
  });

  it('preserves relative alignment between voices when trimming the common silence', async () => {
    // Soprano:   2 rest, then notes  (starts at 256)
    // Alto:      4 rest, then notes  (starts at 512)
    // Tenor:     6 rest, then notes  (starts at 768)
    // Bass:      8 rest, then notes  (starts at 1024)
    //
    // Common trim = min(2,4,6,8) * 128 = 256 ticks. After trim:
    //   Soprano starts at 0
    //   Alto    starts at 256
    //   Tenor   starts at 512
    //   Bass    starts at 768
    // i.e. each voice's relative offset from Soprano is preserved exactly.
    const xml = withLeadingRestsXml([
      { name: 'Soprano', step: 'C', octave: 5, leadingRestQuarters: 2, noteQuarters: 8 },
      { name: 'Alto', step: 'G', octave: 4, leadingRestQuarters: 4, noteQuarters: 6 },
      { name: 'Tenor', step: 'E', octave: 4, leadingRestQuarters: 6, noteQuarters: 4 },
      { name: 'Bass', step: 'C', octave: 4, leadingRestQuarters: 8, noteQuarters: 2 },
    ]);
    const p = writeTmp(xml, '.xml');
    const id = jobId('trim-relative');
    await splitToMidis(id, p);

    expect(firstNoteOnTick(midiPathFor(id, 'soprano'))).toBe(0);
    expect(firstNoteOnTick(midiPathFor(id, 'alto'))).toBe(256);
    expect(firstNoteOnTick(midiPathFor(id, 'tenor'))).toBe(512);
    expect(firstNoteOnTick(midiPathFor(id, 'bass'))).toBe(768);
  });

  it('does not affect downstream timing (note durations + articulation gap still applied)', async () => {
    // Smoke test: with a 2-quarter shared trim, the first note's duration
    // (and the inter-note gap) should be the same as if there had been no
    // leading rests at all — proving the trim only shaves head silence and
    // doesn't accidentally clip into pitched-note territory.
    const xml = withLeadingRestsXml([
      { name: 'Soprano', step: 'C', octave: 5, leadingRestQuarters: 2, noteQuarters: 2 },
      { name: 'Alto', step: 'G', octave: 4, leadingRestQuarters: 2, noteQuarters: 2 },
      { name: 'Tenor', step: 'E', octave: 4, leadingRestQuarters: 2, noteQuarters: 2 },
      { name: 'Bass', step: 'C', octave: 4, leadingRestQuarters: 2, noteQuarters: 2 },
    ]);
    const p = writeTmp(xml, '.xml');
    const id = jobId('trim-preserves-notes');
    await splitToMidis(id, p);

    const sop = parseMidiFile(midiPathFor(id, 'soprano'));
    const ons = sop.events.filter((e) => e.type === 'on').map((e) => e.tick);
    const offs = sop.events.filter((e) => e.type === 'off').map((e) => e.tick);
    // First note at 0 (trim worked), second note at 128 (relative timing
    // intact), first note's off at 128 − ARTIC_GAP (articulation still on).
    expect(ons).toEqual([0, 128]);
    expect(offs).toEqual([128 - ARTIC_GAP, 256 - ARTIC_GAP]);
  });

  it('regression: a score with no leading rests is left untouched (trim=0)', async () => {
    // No leading rests anywhere ⇒ globalHeadTrim = 0 ⇒ output identical to
    // pre-trim behavior. Note that we also verify a voice that follows
    // immediately is unaffected by the new head-trim parameter.
    const xml = withLeadingRestsXml([
      { name: 'Soprano', step: 'C', octave: 5, leadingRestQuarters: 0, noteQuarters: 4 },
      { name: 'Alto', step: 'G', octave: 4, leadingRestQuarters: 0, noteQuarters: 4 },
      { name: 'Tenor', step: 'E', octave: 4, leadingRestQuarters: 0, noteQuarters: 4 },
      { name: 'Bass', step: 'C', octave: 4, leadingRestQuarters: 0, noteQuarters: 4 },
    ]);
    const p = writeTmp(xml, '.xml');
    const id = jobId('trim-noop');
    await splitToMidis(id, p);

    for (const v of VOICES) {
      expect(firstNoteOnTick(midiPathFor(id, v))).toBe(0);
    }
  });

  it('excludes an entirely-empty voice from the trim min (so a silent voice does not force trim=0)', async () => {
    // Some real scores have one of the four staves contain only whole rests
    // for the entire piece (e.g. Bass tacet for a soprano-feature intro).
    // We should still trim based on the voices that *do* sing — a voice
    // with no pitched notes has nothing to contribute to "earliest entry".
    //
    // Construct: Soprano/Alto/Tenor each have 4 quarter rests then notes;
    // Bass has 16 quarter rests, no pitched notes. Common trim should be
    // 4 quarters = 512 ticks, NOT 0.
    const xml = withLeadingRestsXml([
      { name: 'Soprano', step: 'C', octave: 5, leadingRestQuarters: 4, noteQuarters: 4 },
      { name: 'Alto', step: 'G', octave: 4, leadingRestQuarters: 4, noteQuarters: 4 },
      { name: 'Tenor', step: 'E', octave: 4, leadingRestQuarters: 4, noteQuarters: 4 },
      { name: 'Bass', step: 'C', octave: 4, leadingRestQuarters: 16, noteQuarters: 0 },
    ]);
    const p = writeTmp(xml, '.xml');
    const id = jobId('trim-with-tacet');
    await splitToMidis(id, p);

    expect(firstNoteOnTick(midiPathFor(id, 'soprano'))).toBe(0);
    expect(firstNoteOnTick(midiPathFor(id, 'alto'))).toBe(0);
    expect(firstNoteOnTick(midiPathFor(id, 'tenor'))).toBe(0);
    // Bass MIDI has no note-on events at all; nothing to assert here.
    const bass = parseMidiFile(midiPathFor(id, 'bass'));
    expect(bass.events.some((e) => e.type === 'on')).toBe(false);
  });
});
