import { describe, expect, it } from 'vitest';
import { formatDuration } from '../lib/run-monitor';
import { testTranslator } from './test-utils';

describe('formatDuration', () => {
  const t = testTranslator('run');
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 29, 10, 0, 0) + ms).toISOString();
  const start = at(0);

  it('says "under 1 s" instead of "0 s" for a step shorter than a second', () => {
    expect(formatDuration(t, start, at(0))).toBe('under 1 s');
    expect(formatDuration(t, start, at(400))).toBe('under 1 s');
    expect(formatDuration(t, start, at(999))).toBe('under 1 s');
  });

  it('keeps seconds and minutes as before', () => {
    expect(formatDuration(t, start, at(1000))).toBe('1 s');
    expect(formatDuration(t, start, at(42_400))).toBe('42 s');
    expect(formatDuration(t, start, at(125_000))).toBe('2 min 5 s');
    expect(formatDuration(t, null, at(0))).toBeNull();
  });
});
