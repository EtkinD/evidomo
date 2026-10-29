import type { ByteRange } from '../storage/storage.ts';

/**
 * How to answer a `Range` header for a file of `sizeBytes` (RFC 9110 §14):
 * - `full`: no header, another unit, several ranges, or a malformed spec. The server may ignore
 *   a Range it does not serve (Express's `send` does the same), so these get a plain 200;
 * - `partial`: one satisfiable byte range, clipped to the file (206);
 * - `unsatisfiable`: a well-formed range that starts at or beyond the end (416).
 */
export type RangeOutcome =
  | { readonly kind: 'full' }
  | { readonly kind: 'partial'; readonly range: ByteRange }
  | { readonly kind: 'unsatisfiable' };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/i;

export function parseRangeHeader(header: string | undefined, sizeBytes: number): RangeOutcome {
  if (header === undefined) return { kind: 'full' };
  const match = SINGLE_RANGE.exec(header.trim());
  if (match === null) return { kind: 'full' };
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return { kind: 'full' };

  if (first === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix)) return { kind: 'full' };
    if (suffix === 0 || sizeBytes === 0) return { kind: 'unsatisfiable' };
    return {
      kind: 'partial',
      range: { start: Math.max(0, sizeBytes - suffix), end: sizeBytes - 1 },
    };
  }

  const start = Number(first);
  const end = last === '' ? sizeBytes - 1 : Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: 'full' };
  if (last !== '' && end < start) return { kind: 'full' };
  if (start >= sizeBytes) return { kind: 'unsatisfiable' };
  return { kind: 'partial', range: { start, end: Math.min(end, sizeBytes - 1) } };
}
