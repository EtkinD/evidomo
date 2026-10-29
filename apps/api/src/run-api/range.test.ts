import { describe, expect, it } from 'vitest';
import { parseRangeHeader } from './range.ts';

describe('parseRangeHeader', () => {
  it('serves the whole file without a header', () => {
    expect(parseRangeHeader(undefined, 100)).toEqual({ kind: 'full' });
  });

  it('reads closed, open-ended, and suffix ranges, clipped to the file', () => {
    expect(parseRangeHeader('bytes=0-9', 100)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 9 },
    });
    expect(parseRangeHeader('bytes=90-', 100)).toEqual({
      kind: 'partial',
      range: { start: 90, end: 99 },
    });
    expect(parseRangeHeader('bytes=50-500', 100)).toEqual({
      kind: 'partial',
      range: { start: 50, end: 99 },
    });
    expect(parseRangeHeader('bytes=-10', 100)).toEqual({
      kind: 'partial',
      range: { start: 90, end: 99 },
    });
    expect(parseRangeHeader('bytes=-500', 100)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 99 },
    });
    expect(parseRangeHeader('BYTES=1-1', 2)).toEqual({
      kind: 'partial',
      range: { start: 1, end: 1 },
    });
  });

  it('refuses ranges that start at or past the end, and empty suffixes', () => {
    expect(parseRangeHeader('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=100-200', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-5', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores malformed specs, other units, and multiple ranges (whole file)', () => {
    for (const header of [
      'bytes=',
      'bytes=-',
      'bytes=5-1',
      'bytes=a-b',
      'bytes=0-1,4-5',
      'items=0-1',
      'bytes 0-1',
      'bytes=99999999999999999999-',
    ]) {
      expect(parseRangeHeader(header, 100), header).toEqual({ kind: 'full' });
    }
  });
});
