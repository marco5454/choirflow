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

  it('throws with vocal+piano diagnosis when 3 parts include a piano grand staff', async () => {
    // 2 vocal staves + 1 piano part (2 staves declared via <staves>2</staves>).
    const xml =
      '<?xml version="1.0"?><score-partwise>' +
      '<part-list>' +
      '<score-part id="P1"><part-name>Voice</part-name></score-part>' +
      '<score-part id="P2"><part-name>Voice</part-name></score-part>' +
      '<score-part id="P3"><part-name>Piano</part-name></score-part>' +
      '</part-list>' +
      '<part id="P1"><measure number="1"><note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P2"><measure number="1"><note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '<part id="P3"><measure number="1"><attributes><staves>2</staves></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>' +
      '</score-partwise>';
    const p = writeTmp(xml, '.xml');
    const id = jobId('threeparts-vocalpiano');
    await expect(splitToMidis(id, p)).rejects.toThrow(/vocal.*piano|piano accompaniment/i);
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
});
