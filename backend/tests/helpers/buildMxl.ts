/**
 * Build a valid .mxl (compressed MusicXML) archive in memory or on disk.
 *
 * Layout follows the MusicXML container spec:
 *   META-INF/container.xml  declares the rootfile path
 *   <innerName>             the score XML itself
 *
 * Used by tests (in-memory buffers, written to a tmp dir) and by
 * scripts/verify-split.ts (writes directly to a path).
 */

import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

function buildContainerXml(innerName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<container>\n' +
    '  <rootfiles>\n' +
    `    <rootfile full-path="${innerName}" media-type="application/vnd.recordare.musicxml+xml"/>\n` +
    '  </rootfiles>\n' +
    '</container>\n'
  );
}

/**
 * Build a .mxl Buffer from the given XML text.
 * `innerName` is the filename used inside the archive (e.g. "score.xml").
 */
export function buildMxlBuffer(xml: string, innerName = 'score.xml'): Buffer {
  const zip = new AdmZip();
  zip.addFile('META-INF/container.xml', Buffer.from(buildContainerXml(innerName), 'utf-8'));
  zip.addFile(innerName, Buffer.from(xml, 'utf-8'));
  return zip.toBuffer();
}

/**
 * Build a .mxl on disk from a plain MusicXML file. Returns the .mxl path.
 * The inner archive entry name is the source file's basename, so the produced
 * archive looks the same as one MuseScore/music21 would write.
 */
export function buildMxlFixture(srcXmlPath: string, outMxlPath: string): string {
  const xml = fs.readFileSync(srcXmlPath, 'utf-8');
  const innerName = path.basename(srcXmlPath);
  const buf = buildMxlBuffer(xml, innerName);
  fs.writeFileSync(outMxlPath, buf);
  return outMxlPath;
}

/**
 * Build a custom .mxl Buffer where you supply the container.xml verbatim
 * AND the entries map (key = archive path, value = bytes/string). For
 * negative-test fixtures only.
 */
export function buildCustomMxlBuffer(entries: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(entries)) {
    zip.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8'));
  }
  return zip.toBuffer();
}
