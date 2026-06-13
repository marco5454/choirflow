/**
 * Sniff the first bytes of an uploaded file and ensure the content matches
 * the extension multer let through. Defends against renamed payloads
 * (e.g. `evil.exe` saved as `evil.xml`). Without this check, a renamed PDF
 * would still reach Audiveris, which parses fonts/CFF/embedded images and
 * presents broad attack surface to malformed input.
 *
 * Sniff rules (first 512 bytes):
 *   .pdf              -> must start with "%PDF-"
 *   .mxl              -> must start with ZIP local-file-header "PK\x03\x04"
 *   .xml / .musicxml  -> tolerant text check; allow optional UTF-8 BOM, then
 *                        require an XML/MusicXML opening token
 *
 * On mismatch, the temp file is deleted and we forward a 400 to the central
 * error handler. On filesystem read errors we forward through `next(err)`
 * and let the central handler decide.
 */

import type { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';

const SNIFF_BYTES = 512;

const PDF_MAGIC = Buffer.from('%PDF-', 'utf8');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const XML_OPENERS = ['<?xml', '<score-partwise', '<score-timewise'];

function readHead(filePath: string): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function looksLikeXml(buf: Buffer): boolean {
  let head = buf;
  if (head.length >= UTF8_BOM.length && head.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    head = head.subarray(UTF8_BOM.length);
  }
  // Trim leading ASCII whitespace (spaces, tabs, CR, LF). Keep it simple: byte-level.
  let start = 0;
  while (start < head.length) {
    const b = head[start];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
      start++;
    } else {
      break;
    }
  }
  const text = head.subarray(start).toString('utf8');
  return XML_OPENERS.some((tok) => text.startsWith(tok));
}

export function validateUploadContent(req: Request, res: Response, next: NextFunction): void {
  if (!req.file) {
    // No file means upload.single('file') didn't attach one. Let the route
    // handler emit its own "No file uploaded" 400.
    return next();
  }

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();

  let head: Buffer;
  try {
    head = readHead(filePath);
  } catch (err) {
    return next(err instanceof Error ? err : new Error(String(err)));
  }

  let ok: boolean;
  if (ext === '.pdf') {
    ok = head.length >= PDF_MAGIC.length && head.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
  } else if (ext === '.mxl') {
    ok = head.length >= ZIP_MAGIC.length && head.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC);
  } else if (ext === '.xml' || ext === '.musicxml') {
    ok = looksLikeXml(head);
  } else {
    // Multer's fileFilter should have rejected anything else, but if a future
    // change widens ALLOWED_EXT without updating this middleware, fail closed.
    ok = false;
  }

  if (ok) {
    return next();
  }

  // Reject: clean up the temp file before responding so we don't accumulate
  // garbage on disk for repeated bad requests.
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best-effort cleanup; swallow
  }

  return next(new Error('File content does not match its extension'));
}
