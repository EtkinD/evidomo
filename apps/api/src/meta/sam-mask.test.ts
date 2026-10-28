import { InvalidSegmentationMaskError } from '@meta-sam/parser';
import { describe, expect, it } from 'vitest';
import { decodeSamMask, maskArea, SamMaskError } from './sam-mask.ts';
import { recordedMasks } from './sam-test-support.ts';

const masks = await recordedMasks();
const [small, small2] = masks;
if (small === undefined || small2 === undefined) throw new Error('integrity cassette has no masks');

/** Expects `decodeSamMask` to throw a `SamMaskError` wrapping the parser's error. */
function expectWrappedRejection(mask: Parameters<typeof decodeSamMask>[0]): SamMaskError {
  let caught: unknown;
  try {
    decodeSamMask(mask);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SamMaskError);
  if (!(caught instanceof SamMaskError)) throw new Error('unreachable');
  expect(caught.cause).toBeInstanceOf(InvalidSegmentationMaskError);
  return caught;
}

describe('decodeSamMask (wrapper over @meta-sam/parser)', () => {
  it('decodes all 57 recorded masks to box-sized 0/1 rasters', () => {
    expect(masks).toHaveLength(57);
    for (const { mask, raster, area } of masks) {
      expect(mask.encoding).toBe('one_bit');
      expect(raster).toHaveLength(mask.width * mask.height);
      expect(raster.every((value) => value === 0 || value === 1)).toBe(true);
      // A mask fills part of its box: never empty, never more than the box.
      expect(area).toBeGreaterThan(0);
      expect(area).toBeLessThanOrEqual(raster.length);
      // Byte comparison: toEqual on megapixel typed arrays times out under full-suite load.
      expect(Buffer.from(decodeSamMask(mask)).equals(raster)).toBe(true);
    }
  });

  it('decodes the smallest recorded mask to known values', () => {
    // A cabinet door edge in kitchen-cluttered: 25x275, 5,871 foreground pixels.
    expect(small.mask).toMatchObject({ width: 25, height: 275 });
    expect(small.area).toBe(5871);
    // Top row: the door's slanted top edge covers only columns 3-5.
    expect(small.raster.subarray(0, 25).join('')).toBe('0001110000000000000000000');
    expect(small2.mask).toMatchObject({ width: 22, height: 315 });
    expect(small2.area).toBe(5417);
  });

  it('wraps a truncated payload', () => {
    const error = expectWrappedRejection({
      ...small.mask,
      payload: small.mask.payload.slice(0, -4),
    });
    expect(error.message).toMatch(/^Invalid SAM mask: /);
  });

  it('wraps a dimension mismatch', () => {
    expectWrappedRejection({ ...small.mask, width: small.mask.width + 1 });
    expectWrappedRejection({ ...small.mask, height: small.mask.height - 1 });
    expectWrappedRejection({ ...small.mask, width: small2.mask.width, height: small2.mask.height });
  });

  it('wraps a wrong marker, a marker-less payload, and invalid dimensions', () => {
    expectWrappedRejection({ ...small.mask, encoding: 'lossless' });
    // @meta-sam/parser@0.1.0 needs the marker in `payload`, despite its type comment.
    expectWrappedRejection({ ...small.mask, payload: small.mask.payload.slice(1) });
    expectWrappedRejection({ ...small.mask, width: 0 });
  });

  it('wraps a corrupted payload', () => {
    const payload = small.mask.payload;
    const index = Math.floor(payload.length / 2);
    const swapped = payload[index] === 'A' ? 'B' : 'A';
    expectWrappedRejection({
      ...small.mask,
      payload: `${payload.slice(0, index)}${swapped}${payload.slice(index + 1)}`,
    });
  });
});

describe('maskArea', () => {
  it('counts foreground pixels', () => {
    expect(maskArea(Uint8Array.from([0, 1, 1, 0, 1]))).toBe(3);
    expect(maskArea(new Uint8Array(0))).toBe(0);
  });
});
