/**
 * Reads a MusicXML score from disk and returns its raw XML text.
 *
 * Supports two on-disk formats:
 *   1. Plain MusicXML (`.xml`, `.musicxml`) — read as UTF-8.
 *   2. Compressed MusicXML (`.mxl`) — a ZIP archive whose entry pointed at by
 *      META-INF/container.xml's <rootfile full-path="..."/> is the actual score.
 *
 * The extension is the primary hint, but as a safety net we also sniff the
 * first bytes for the ZIP magic number ("PK\x03\x04") so a misnamed file
 * (e.g. a .xml that's actually zipped) still works.
 *
 * Errors are thrown as MusicXmlValidationError so they surface to the upload
 * client as a 400 with a human-readable message, matching the rest of the
 * splitParts pipeline.
 */

import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { MusicXmlValidationError } from './splitParts';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const UTF8_BOM = '\uFEFF';

const NOT_MXL_HINT =
  'This file should be a compressed MusicXML archive (.mxl) — a ZIP containing ' +
  'META-INF/container.xml plus the score XML. If you exported from MuseScore, ' +
  'choose "MusicXML" or "Compressed MusicXML" from the export dialog.';

/**
 * Read up to the first 4 bytes of a file to check for the ZIP magic number.
 * Cheap: opens, reads 4 bytes, closes.
 */
async function looksLikeZip(filePath: string): Promise<boolean> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf.equals(ZIP_MAGIC);
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/**
 * Parse META-INF/container.xml and return the rootfile's full-path attribute.
 * Per the MusicXML spec, container.xml may declare multiple <rootfile>
 * elements; convention is that the first is the primary score. We take [0]
 * and ignore the rest.
 */
function extractRootfilePath(containerXml: string): string {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
  });

  let parsed: any;
  try {
    parsed = parser.parse(containerXml);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MusicXmlValidationError(
      `Failed to parse META-INF/container.xml inside .mxl archive: ${detail}`,
    );
  }

  const rootfilesNode = parsed?.container?.rootfiles?.rootfile;
  // rootfile may be a single object or an array depending on archive contents.
  const rootfile = Array.isArray(rootfilesNode) ? rootfilesNode[0] : rootfilesNode;
  const fullPath: unknown = rootfile?.['@_full-path'];

  if (typeof fullPath !== 'string' || fullPath.length === 0) {
    throw new MusicXmlValidationError(
      'Invalid .mxl archive: META-INF/container.xml has no <rootfile full-path="..."/>. ' +
        NOT_MXL_HINT,
    );
  }

  return fullPath;
}

/**
 * Open a .mxl archive and return the score XML text.
 */
function readMxl(filePath: string): string {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MusicXmlValidationError(
      `Failed to open .mxl archive (not a valid ZIP file): ${detail}. ${NOT_MXL_HINT}`,
    );
  }

  const containerEntry = zip.getEntry('META-INF/container.xml');
  if (!containerEntry) {
    throw new MusicXmlValidationError(
      'Invalid .mxl archive: missing META-INF/container.xml. ' + NOT_MXL_HINT,
    );
  }

  const containerXml = containerEntry.getData().toString('utf-8');
  const rootfilePath = extractRootfilePath(containerXml);

  const scoreEntry = zip.getEntry(rootfilePath);
  if (!scoreEntry) {
    throw new MusicXmlValidationError(
      `Invalid .mxl archive: rootfile "${rootfilePath}" declared in META-INF/container.xml is not present in the archive.`,
    );
  }

  return scoreEntry.getData().toString('utf-8');
}

/**
 * Strip a leading UTF-8 BOM if present. fast-xml-parser tolerates BOMs in
 * most cases, but our pre-parse "starts with <" check in splitParts does not,
 * so we normalize here.
 */
function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

/**
 * Public entry point. Reads the file at `inputPath` and returns the raw
 * MusicXML text, transparently handling .mxl decompression.
 */
export async function loadMusicXmlText(inputPath: string): Promise<string> {
  const ext = path.extname(inputPath).toLowerCase();

  // Treat .mxl as zip. Also fall through to zip handling for any file whose
  // first 4 bytes are the ZIP magic — covers misnamed archives.
  const treatAsZip = ext === '.mxl' || (await looksLikeZip(inputPath));

  if (treatAsZip) {
    return stripBom(readMxl(inputPath));
  }

  const raw = await fs.promises.readFile(inputPath, 'utf-8');
  return stripBom(raw);
}
