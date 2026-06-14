import { extOf, humanSize } from './format';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = '.xml,.musicxml,.mxl,.pdf';
const ACCEPTED_EXT_SET = new Set(['.xml', '.musicxml', '.mxl', '.pdf']);

export function validateFile(f: File): string | null {
  const ext = extOf(f.name);
  if (!ACCEPTED_EXT_SET.has(ext)) {
    return `Unsupported file type "${ext || '(none)'}". Use .xml, .musicxml, .mxl, or .pdf.`;
  }
  if (f.size > MAX_UPLOAD_BYTES) {
    return `File is ${humanSize(f.size)}, which exceeds the 50 MB limit.`;
  }
  if (f.size === 0) {
    return 'File is empty.';
  }
  return null;
}
