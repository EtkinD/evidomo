import { RUN_FACT_MASK_PNG, type SamRegion } from '@evidomo/shared';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { recordedMaskAt, type RecordedMask } from '../meta/sam-test-support.ts';
import { encodeMaskPng, renderMaskLayer } from './mask.ts';

// Recorded SAM masks (P1-05 cassette, synthetic interiors) placed at known boxes: the overlay must
// put exactly the decoded raster's pixels at the box, in the photo frame.

// Large enough for the two smallest recorded masks side by side.
const FRAME = { width: 2048, height: 2048 };

function regionAt(recorded: RecordedMask, x0: number, y0: number): SamRegion {
  const { mask } = recorded;
  return {
    objectId: 0,
    score: 0.9,
    box: { x0, y0, x1: x0 + mask.width, y1: y0 + mask.height },
    region: {
      x: x0 / FRAME.width,
      y: y0 / FRAME.height,
      width: mask.width / FRAME.width,
      height: mask.height / FRAME.height,
    },
    mask: { ...mask },
  };
}

/** The alpha a correct overlay has at (x, y): the union of the placed rasters. */
function expectedAlpha(placed: readonly { recorded: RecordedMask; x0: number; y0: number }[]) {
  const alpha = new Uint8Array(FRAME.width * FRAME.height);
  for (const { recorded, x0, y0 } of placed) {
    const { width, height } = recorded.mask;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (recorded.raster[y * width + x] === 1) alpha[(y0 + y) * FRAME.width + x0 + x] = 255;
      }
    }
  }
  return alpha;
}

function alphaOf(rgba: Uint8Array): Uint8Array {
  const alpha = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3] ?? 0;
  return alpha;
}

describe('renderMaskLayer', () => {
  it('places each decoded mask at its box, white and opaque, transparent elsewhere', async () => {
    const small = await recordedMaskAt(0);
    const other = await recordedMaskAt(1);
    const placed = [
      { recorded: small, x0: 10, y0: 20 },
      { recorded: other, x0: 20 + small.mask.width, y0: 7 },
    ];

    const layer = renderMaskLayer(
      FRAME.width,
      FRAME.height,
      placed.map((p) => regionAt(p.recorded, p.x0, p.y0)),
    );

    expect(layer.kind).toBe('rendered');
    if (layer.kind !== 'rendered') return;
    expect([layer.width, layer.height, layer.drawn, layer.skipped]).toEqual([
      FRAME.width,
      FRAME.height,
      2,
      0,
    ]);
    // Buffer equality: a structural diff of millions of pixels would exhaust the worker.
    expect(Buffer.from(alphaOf(layer.rgba)).equals(Buffer.from(expectedAlpha(placed)))).toBe(true);
    const [r, g, b, a] = RUN_FACT_MASK_PNG.maskRgba;
    let foreign = 0;
    for (let i = 0; i < layer.rgba.length; i += 4) {
      const [pr, pg, pb, pa] = layer.rgba.subarray(i, i + 4);
      const transparent = pr === 0 && pg === 0 && pb === 0 && pa === 0;
      if (!transparent && !(pr === r && pg === g && pb === b && pa === a)) foreign += 1;
    }
    expect(foreign).toBe(0);
  });

  it('skips regions it cannot place and reports empty when nothing is left', async () => {
    const recorded = await recordedMaskAt(0);
    const { mask } = recorded;
    const outside = regionAt(recorded, FRAME.width - mask.width + 1, 0);
    const wrongSize = { ...regionAt(recorded, 0, 0), mask: { ...mask, width: mask.width + 1 } };
    const undecodable = { ...regionAt(recorded, 0, 0), mask: { ...mask, payload: '!!' } };
    const capped = { ...regionAt(recorded, 0, 0), mask: null };

    expect(
      renderMaskLayer(FRAME.width, FRAME.height, [outside, wrongSize, undecodable, capped]),
    ).toEqual({
      kind: 'empty',
      skipped: 4,
    });
    expect(renderMaskLayer(FRAME.width, FRAME.height, [])).toEqual({ kind: 'empty', skipped: 0 });

    const mixed = renderMaskLayer(FRAME.width, FRAME.height, [capped, regionAt(recorded, 5, 5)]);
    expect(mixed.kind === 'rendered' ? [mixed.drawn, mixed.skipped] : mixed).toEqual([1, 1]);
  });
});

describe('encodeMaskPng', () => {
  it('encodes an RGBA PNG of the frame that decodes back to the layer', async () => {
    const recorded = await recordedMaskAt(2);
    const layer = renderMaskLayer(FRAME.width, FRAME.height, [regionAt(recorded, 40, 60)]);
    if (layer.kind !== 'rendered') throw new Error('Expected a rendered layer');

    const png = await encodeMaskPng(layer);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });

    expect((await sharp(png).metadata()).format).toBe('png');
    expect(info).toMatchObject({ width: FRAME.width, height: FRAME.height, channels: 4 });
    expect(Buffer.from(data).equals(Buffer.from(layer.rgba))).toBe(true);
  });
});
