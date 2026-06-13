import { describe, it, expect } from 'vitest';
import { isValidJobId } from '../../src/utils/jobId';

describe('isValidJobId', () => {
  it('accepts a canonical lowercase uuid v4', () => {
    expect(isValidJobId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('accepts uppercase uuid v4', () => {
    expect(isValidJobId('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('rejects uuid v1 (version digit not 4)', () => {
    // canonical v1 example — version digit at the 13th hex position is 1
    expect(isValidJobId('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });

  it('rejects uuid with wrong variant digit', () => {
    // variant digit at the 17th hex position must be 8/9/a/b — here it's c
    expect(isValidJobId('550e8400-e29b-41d4-c716-446655440000')).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    expect(isValidJobId('../foo')).toBe(false);
    expect(isValidJobId('..%2Ffoo')).toBe(false);
    expect(isValidJobId('/etc/passwd')).toBe(false);
  });

  it('rejects empty string and non-uuid garbage', () => {
    expect(isValidJobId('')).toBe(false);
    expect(isValidJobId('not-a-uuid')).toBe(false);
    expect(isValidJobId('550e8400-e29b-41d4-a716-44665544000')).toBe(false); // too short
    expect(isValidJobId('550e8400-e29b-41d4-a716-4466554400000')).toBe(false); // too long
  });
});
