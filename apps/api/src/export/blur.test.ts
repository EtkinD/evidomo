import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  blurPhoto,
  blurRawRegions,
  paddedBox,
  PhotoBlurError,
  privacyPlan,
  type PixelBox,
  type RawImage,
} from './blur.ts';
import {
  FRAME,
  inventoryEntry,
  privacyRegion,
  recordedMaskRegion,
  syntheticPhoto,
  type PrivacySpec,
} from './testing.ts';

// The privacy rules for exported originals and the blur itself, on synthetic images whose
// "faces" are black-and-white checkerboards.

const BOX: PixelBox = { x0: 400, y0: 200, x1: 520, y1: 330 };
const MATERIAL = '0b7f2a0e-5c1d-4d6e-9a51-000000000001';

function photo(privacy: PrivacySpec) {
  return inventoryEntry({
    materialId: MATERIAL,
    sha256: 'a'.repeat(64),
    subject: 'living_room',
    coverRank: 1,
    privacy,
  });
}

async function raw(bytes: Uint8Array): Promise<RawImage> {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 3 };
}

/** Mean and variance of the luminance-ish channel sum inside a box. */
function stats(image: RawImage, box: PixelBox): { mean: number; variance: number } {
  const values: number[] = [];
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      const o = (y * image.width + x) * 3;
      values.push(((image.data[o] ?? 0) + (image.data[o + 1] ?? 0) + (image.data[o + 2] ?? 0)) / 3);
    }
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, variance };
}

/** Mean absolute per-channel difference outside `exclude`. */
function meanDiffOutside(a: RawImage, b: RawImage, exclude: PixelBox): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      if (x >= exclude.x0 && x < exclude.x1 && y >= exclude.y0 && y < exclude.y1) continue;
      const o = (y * a.width + x) * 3;
      for (let c = 0; c < 3; c += 1) sum += Math.abs((a.data[o + c] ?? 0) - (b.data[o + c] ?? 0));
      n += 3;
    }
  }
  return sum / n;
}

describe('privacyPlan (which originals may be exported)', () => {
  it('exports a clear photo as is and a masked photo with every region to blur', async () => {
    expect(privacyPlan(photo({ status: 'clear' }))).toEqual({ status: 'exportable', boxes: [] });
    const person = await recordedMaskRegion(100, 100);
    const plate = privacyRegion({ x0: 600, y0: 500, x1: 700, y1: 540 });
    expect(privacyPlan(photo({ status: 'masked', person: [person], plate: [plate] }))).toEqual({
      status: 'exportable',
      boxes: [person.box, plate.box],
    });
  });

  it('withholds photos whose privacy check is incomplete', () => {
    expect(privacyPlan(photo({ status: 'review' }))).toEqual({
      status: 'withheld',
      reason: 'privacy_review',
    });
    expect(privacyPlan(photo({ status: 'failed' }))).toEqual({
      status: 'withheld',
      reason: 'privacy_failed',
    });
  });

  it('withholds a masked photo without regions instead of publishing it unblurred', () => {
    expect(privacyPlan(photo({ status: 'masked', person: [], plate: [] }))).toEqual({
      status: 'withheld',
      reason: 'privacy_regions_invalid',
    });
  });

  it('withholds a photo whose region or mask does not fit or does not decode', async () => {
    const outside = privacyRegion({ x0: 1000, y0: 10, x1: 1024, y1: 40 });
    const tooWide = { ...outside, box: { x0: 1000, y0: 10, x1: 1100, y1: 40 } };
    expect(privacyPlan(photo({ status: 'masked', person: [tooWide], plate: [] }))).toMatchObject({
      reason: 'privacy_regions_invalid',
    });

    const person = await recordedMaskRegion(100, 100);
    if (person.mask === null) throw new Error('recorded region has a mask');
    const wrongSize = { ...person, mask: { ...person.mask, width: person.mask.width + 1 } };
    expect(privacyPlan(photo({ status: 'masked', person: [wrongSize], plate: [] }))).toMatchObject({
      reason: 'privacy_regions_invalid',
    });
    const corrupt = { ...person, mask: { ...person.mask, payload: '!not-base85 ~~' } };
    expect(privacyPlan(photo({ status: 'masked', person: [corrupt], plate: [] }))).toMatchObject({
      reason: 'privacy_regions_invalid',
    });
  });
});

describe('paddedBox', () => {
  it('adds 10% of the longer side plus 2 px and clips to the image', () => {
    expect(paddedBox({ x0: 100, y0: 100, x1: 200, y1: 150 }, 1024, 682)).toEqual({
      x0: 88,
      y0: 88,
      x1: 212,
      y1: 162,
    });
    expect(paddedBox({ x0: 0, y0: 650, x1: 50, y1: 682 }, 1024, 682)).toEqual({
      x0: 0,
      y0: 643,
      x1: 57,
      y1: 682,
    });
  });
});

describe('blur', () => {
  let source: Uint8Array;
  let sourceRaw: RawImage;

  beforeAll(async () => {
    source = await syntheticPhoto([200, 180, 160], [BOX]);
    sourceRaw = await raw(source);
  });

  it('flattens the region and leaves every pixel outside the padded box untouched (raw)', async () => {
    const blurred = await blurRawRegions(sourceRaw, [BOX]);
    const before = stats(sourceRaw, BOX);
    const after = stats(blurred, BOX);
    // The checkerboard has a variance of ~16,000; pixelate + blur leaves next to nothing.
    expect(before.variance).toBeGreaterThan(10_000);
    expect(after.variance).toBeLessThan(before.variance / 50);
    expect(Math.abs(after.mean - before.mean)).toBeLessThan(25);
    expect(meanDiffOutside(sourceRaw, blurred, paddedBox(BOX, FRAME.width, FRAME.height))).toBe(0);
  });

  it('re-encodes a blurred JPEG without metadata, close to the original outside the region', async () => {
    const blurred = await blurPhoto(source, FRAME, [BOX]);
    expect([blurred.width, blurred.height]).toEqual([FRAME.width, FRAME.height]);
    const blurredRaw = await raw(blurred.bytes);
    expect(stats(blurredRaw, BOX).variance).toBeLessThan(stats(sourceRaw, BOX).variance / 50);
    // Outside: only JPEG generation loss.
    const padded = paddedBox(BOX, FRAME.width, FRAME.height);
    expect(meanDiffOutside(sourceRaw, blurredRaw, padded)).toBeLessThan(2);
    const metadata = await sharp(blurred.bytes).metadata();
    expect([metadata.format, metadata.exif, metadata.xmp, metadata.icc]).toEqual([
      'jpeg',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('is deterministic on one machine', async () => {
    const a = await blurPhoto(source, FRAME, [BOX]);
    const b = await blurPhoto(source, FRAME, [BOX]);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('blurs a region at the image edge and overlapping regions', async () => {
    const edge: PixelBox = { x0: 0, y0: 600, x1: 60, y1: 682 };
    const photoBytes = await syntheticPhoto([90, 120, 150], [edge, BOX]);
    const out = await raw((await blurPhoto(photoBytes, FRAME, [edge, BOX, BOX])).bytes);
    expect(stats(out, edge).variance).toBeLessThan(500);
    expect(stats(out, BOX).variance).toBeLessThan(500);
  });

  it('fails with PhotoBlurError for undecodable bytes or a frame that does not match', async () => {
    await expect(blurPhoto(new Uint8Array([1, 2, 3]), FRAME, [BOX])).rejects.toThrow(
      PhotoBlurError,
    );
    await expect(blurPhoto(source, { width: 800, height: 600 }, [BOX])).rejects.toThrow(
      PhotoBlurError,
    );
  });
});
