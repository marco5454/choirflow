import { describe, it, expect } from 'vitest';
import { validateFile, MAX_UPLOAD_BYTES } from './validate';

function makeFile(name: string, size: number): File {
  // Use a Blob of the requested size, then wrap as File.
  const blob = new Blob([new Uint8Array(size)]);
  return new File([blob], name, { type: 'application/octet-stream' });
}

describe('validateFile', () => {
  it('accepts a small .xml file', () => {
    expect(validateFile(makeFile('score.xml', 1024))).toBeNull();
  });

  it('accepts .musicxml, .mxl, and .pdf', () => {
    expect(validateFile(makeFile('a.musicxml', 1024))).toBeNull();
    expect(validateFile(makeFile('a.mxl', 1024))).toBeNull();
    expect(validateFile(makeFile('a.pdf', 1024))).toBeNull();
  });

  it('rejects an unsupported extension', () => {
    const err = validateFile(makeFile('song.midi', 1024));
    expect(err).toMatch(/Unsupported file type/);
    expect(err).toContain('.midi');
  });

  it('rejects a file with no extension', () => {
    const err = validateFile(makeFile('noext', 1024));
    expect(err).toMatch(/Unsupported file type/);
    expect(err).toContain('(none)');
  });

  it('rejects a file over the 50 MB limit', () => {
    const err = validateFile(makeFile('big.pdf', MAX_UPLOAD_BYTES + 1));
    expect(err).toMatch(/exceeds the 50 MB limit/);
  });

  it('accepts a file at exactly the size limit', () => {
    expect(validateFile(makeFile('edge.pdf', MAX_UPLOAD_BYTES))).toBeNull();
  });

  it('rejects an empty file', () => {
    expect(validateFile(makeFile('empty.xml', 0))).toBe('File is empty.');
  });

  it('accepts uppercase extensions (case-insensitive)', () => {
    expect(validateFile(makeFile('SCORE.XML', 1024))).toBeNull();
    expect(validateFile(makeFile('Song.PDF', 1024))).toBeNull();
  });
});
