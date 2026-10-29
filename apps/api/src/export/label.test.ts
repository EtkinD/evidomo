import { STAGED_IMAGE_LABEL } from '@evidomo/shared';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { STAGED_DIGITAL_SOURCE_TYPE } from '../pipeline/staging/encode.ts';
import { burnStagedLabel, StagedLabelError, stagedLabelBadge } from './label.ts';
import { FRAME, syntheticPhoto } from './testing.ts';

// The visible disclosure burned into exported staged images.

async function raw(bytes: Uint8Array) {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width };
}

describe('stagedLabelBadge', () => {
  it('draws the label as strokes (no font needed) in the bottom-left corner', () => {
    const badge = stagedLabelBadge(FRAME.width, FRAME.height);
    expect(badge.svg).not.toContain('<text');
    expect(badge.svg).toContain('<path');
    const margin = Math.round(FRAME.height * 0.025);
    expect(badge.left).toBe(margin);
    expect(badge.top + badge.height).toBe(FRAME.height - margin);
    // About 3% of the shorter side per cap height: legible, not dominant.
    expect(badge.height).toBeGreaterThan(30);
    expect(badge.width).toBeLessThan(FRAME.width / 4);
  });

  it('has a glyph for every character of the shared label', () => {
    expect(() => stagedLabelBadge(1024, 682, STAGED_IMAGE_LABEL)).not.toThrow();
    expect(() => stagedLabelBadge(1024, 682, 'Virtually staged!')).toThrow(StagedLabelError);
  });

  it('shrinks to fit a narrow image and refuses one too small to be legible', () => {
    const narrow = stagedLabelBadge(160, 600);
    expect(narrow.left + narrow.width).toBeLessThanOrEqual(160);
    expect(() => stagedLabelBadge(40, 40)).toThrow(StagedLabelError);
  });

  it('is deterministic', () => {
    expect(stagedLabelBadge(2048, 1365).svg).toBe(stagedLabelBadge(2048, 1365).svg);
  });
});

describe('burnStagedLabel', () => {
  let source: Uint8Array;

  beforeAll(async () => {
    source = await syntheticPhoto([214, 196, 170]);
  });

  it('burns a dark badge with light strokes into the pixels and nowhere else', async () => {
    const out = await burnStagedLabel(source);
    expect([out.width, out.height]).toEqual([FRAME.width, FRAME.height]);
    const before = await raw(source);
    const after = await raw(out.bytes);
    const { left, top, width, height } = out.badge;
    let dark = 0;
    let light = 0;
    let outsideDiff = 0;
    let outsideCount = 0;
    for (let y = 0; y < FRAME.height; y += 1) {
      for (let x = 0; x < FRAME.width; x += 1) {
        const o = (y * FRAME.width + x) * 3;
        const value =
          ((after.data[o] ?? 0) + (after.data[o + 1] ?? 0) + (after.data[o + 2] ?? 0)) / 3;
        const inside = x >= left && x < left + width && y >= top && y < top + height;
        if (inside) {
          if (value < 70) dark += 1;
          if (value > 200) light += 1;
        } else if (x < left - 8 || x >= left + width + 8 || y < top - 8 || y >= top + height + 8) {
          outsideDiff += Math.abs((after.data[o] ?? 0) - (before.data[o] ?? 0));
          outsideCount += 1;
        }
      }
    }
    const area = width * height;
    expect(dark / area).toBeGreaterThan(0.5);
    expect(light / area).toBeGreaterThan(0.08);
    expect(outsideDiff / outsideCount).toBeLessThan(2);
  });

  it('keeps the IPTC DigitalSourceType marker and no other metadata', async () => {
    const out = await burnStagedLabel(source);
    const metadata = await sharp(out.bytes).metadata();
    expect(metadata.xmp?.toString('utf8')).toContain(STAGED_DIGITAL_SOURCE_TYPE);
    expect([metadata.exif, metadata.icc]).toEqual([undefined, undefined]);
  });

  it('is deterministic on one machine', async () => {
    const a = await burnStagedLabel(source);
    const b = await burnStagedLabel(source);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('fails with StagedLabelError for bytes that are not an image', async () => {
    await expect(burnStagedLabel(new Uint8Array([0xff, 0xd8, 0x00]))).rejects.toThrow(
      StagedLabelError,
    );
  });
});
