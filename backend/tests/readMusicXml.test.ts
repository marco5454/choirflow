/**
 * Tests for readMusicXml.ts: plain MusicXML pass-through and .mxl unwrap.
 *
 * Hermetic — uses tmp dirs only, no fixtures from disk except via direct
 * read of an existing one to drive the .mxl roundtrip case.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadMusicXmlText } from '../src/pipeline/readMusicXml';
import { MusicXmlValidationError } from '../src/pipeline/splitParts';
import { buildMxlBuffer, buildCustomMxlBuffer } from './helpers/buildMxl';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const OPEN_FIXTURE = path.join(FIXTURES, 'satb-sample.xml');

const tmpDirs: string[] = [];

function tmpFile(contents: string | Buffer, ext: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'choirflow-readxml-'));
  tmpDirs.push(dir);
  const p = path.join(dir, `score${ext}`);
  fs.writeFileSync(p, contents);
  return p;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('loadMusicXmlText – plain XML', () => {
  it('returns file contents unchanged', async () => {
    const xml = '<?xml version="1.0"?>\n<score-partwise><part-list/></score-partwise>';
    const p = tmpFile(xml, '.xml');
    const out = await loadMusicXmlText(p);
    expect(out).toBe(xml);
  });

  it('strips a leading UTF-8 BOM', async () => {
    const xml = '<?xml version="1.0"?><score-partwise/>';
    const withBom = '\uFEFF' + xml;
    const p = tmpFile(withBom, '.xml');
    const out = await loadMusicXmlText(p);
    expect(out.startsWith('\uFEFF')).toBe(false);
    expect(out).toBe(xml);
  });

  it('reads .musicxml extension the same as .xml', async () => {
    const xml = '<?xml version="1.0"?><score-partwise/>';
    const p = tmpFile(xml, '.musicxml');
    const out = await loadMusicXmlText(p);
    expect(out).toBe(xml);
  });
});

describe('loadMusicXmlText – .mxl archives', () => {
  it('unwraps a well-formed .mxl built from the open-score fixture', async () => {
    const original = fs.readFileSync(OPEN_FIXTURE, 'utf-8');
    const mxl = buildMxlBuffer(original, 'satb-sample.xml');
    const p = tmpFile(mxl, '.mxl');

    const out = await loadMusicXmlText(p);
    expect(out).toBe(original);
  });

  it('detects ZIP content even when extension is .xml (magic-byte sniff)', async () => {
    const original = '<?xml version="1.0"?><score-partwise/>';
    const mxl = buildMxlBuffer(original, 'inner.xml');
    // Save with .xml extension on purpose.
    const p = tmpFile(mxl, '.xml');

    const out = await loadMusicXmlText(p);
    expect(out).toBe(original);
  });

  it('throws MusicXmlValidationError on garbage masquerading as .mxl', async () => {
    const p = tmpFile(Buffer.from('not a zip, just bytes'), '.mxl');
    await expect(loadMusicXmlText(p)).rejects.toBeInstanceOf(MusicXmlValidationError);
    await expect(loadMusicXmlText(p)).rejects.toThrow(/not a valid ZIP/i);
  });

  it('throws when .mxl is missing META-INF/container.xml', async () => {
    const buf = buildCustomMxlBuffer({
      'score.xml': '<?xml version="1.0"?><score-partwise/>',
    });
    const p = tmpFile(buf, '.mxl');
    await expect(loadMusicXmlText(p)).rejects.toThrow(/META-INF\/container\.xml/);
  });

  it('throws when container.xml has no <rootfile full-path>', async () => {
    const badContainer =
      '<?xml version="1.0"?><container><rootfiles></rootfiles></container>';
    const buf = buildCustomMxlBuffer({
      'META-INF/container.xml': badContainer,
      'score.xml': '<?xml version="1.0"?><score-partwise/>',
    });
    const p = tmpFile(buf, '.mxl');
    await expect(loadMusicXmlText(p)).rejects.toThrow(/rootfile/i);
  });

  it('throws when the declared rootfile is not present in the archive', async () => {
    const container =
      '<?xml version="1.0"?><container><rootfiles>' +
      '<rootfile full-path="missing.xml" media-type="application/vnd.recordare.musicxml+xml"/>' +
      '</rootfiles></container>';
    const buf = buildCustomMxlBuffer({
      'META-INF/container.xml': container,
      'something-else.xml': '<?xml version="1.0"?><score-partwise/>',
    });
    const p = tmpFile(buf, '.mxl');
    await expect(loadMusicXmlText(p)).rejects.toThrow(/missing\.xml/);
  });
});
