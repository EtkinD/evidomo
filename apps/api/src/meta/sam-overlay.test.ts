import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeRgbaPng } from '../media/png.ts';
import { imageDimensions } from './images.ts';
import type { SamInstance } from './sam-output.ts';
import { renderOverlayLayer, renderSamOverlayPng } from './sam-overlay.ts';
import { recordedMaskAt, SAMPLES_DIR } from './sam-test-support.ts';

// Same policy as media/convert.test.ts: skipped locally without ffmpeg, always run in CI.
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const runFfmpegTests = ffmpegAvailable || (process.env['CI'] ?? '') !== '';

// The smallest recorded mask (25x275), placed with its box at (6, 5).
const SMALL = await recordedMaskAt(0);
const BOX = { x0: 6, y0: 5, x1: 6 + SMALL.mask.width, y1: 5 + SMALL.mask.height };

function instance(): SamInstance {
  return { objectId: 0, score: 1, box: BOX, mask: SMALL.mask };
}

/** First mask pixel with the given value at least `margin` pixels inside the box edges. */
function interiorPixel(value: 0 | 1, margin: number): { x: number; y: number } {
  const { width, height } = SMALL.mask;
  for (let y = margin; y < height - margin; y += 1) {
    for (let x = margin; x < width - margin; x += 1) {
      if (SMALL.raster[y * width + x] === value) return { x, y };
    }
  }
  throw new Error(`no interior pixel with value ${value}`);
}

describe('encodeRgbaPng', () => {
  it('writes a PNG whose header and pixel data read back', () => {
    const rgba = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => i);
    const png = encodeRgbaPng(3, 2, rgba);
    expect(imageDimensions(png)).toEqual({ format: 'png', width: 3, height: 2 });
    const idatAt = png.indexOf('IDAT');
    const length = png.readUInt32BE(idatAt - 4);
    const scanlines = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + length));
    expect(scanlines[0]).toBe(0);
    expect([...scanlines.subarray(1, 13)]).toEqual([...rgba.subarray(0, 12)]);
    expect(() => encodeRgbaPng(3, 2, new Uint8Array(5))).toThrow(RangeError);
  });
});

describe('renderOverlayLayer', () => {
  it('places the decoded mask at the box corner and outlines the box', () => {
    const width = 40;
    const layer = renderOverlayLayer(width, 290, [
      { instances: [instance()], color: [10, 20, 30] },
    ]);
    const alpha = (x: number, y: number): number => layer[(y * width + x) * 4 + 3] ?? -1;
    expect(alpha(0, 0)).toBe(0); // outside everything
    expect(alpha(BOX.x0, BOX.y0)).toBe(255); // box edge wins over the mask fill
    expect(
      layer.subarray((BOX.y0 * width + BOX.x0) * 4, (BOX.y0 * width + BOX.x0) * 4 + 3),
    ).toEqual(Uint8Array.from([10, 20, 30]));
    expect(alpha(BOX.x1, BOX.y0)).toBe(0); // x1 is exclusive
    const inside = interiorPixel(1, 4);
    expect(alpha(BOX.x0 + inside.x, BOX.y0 + inside.y)).toBe(110); // mask fill
    const background = interiorPixel(0, 4);
    expect(alpha(BOX.x0 + background.x, BOX.y0 + background.y)).toBe(0); // box, not mask
  });

  it('rejects a box outside the image', () => {
    expect(() =>
      renderOverlayLayer(20, 20, [{ instances: [instance()], color: [0, 0, 0] }]),
    ).toThrow(RangeError);
  });
});

describe.skipIf(!runFfmpegTests)('renderSamOverlayPng (real ffmpeg)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sam-overlay-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('composites the layer over a sample image into a PNG of the same size', async () => {
    const outputPath = path.join(dir, 'nested', 'overlay.png');
    await renderSamOverlayPng({
      imagePath: path.join(SAMPLES_DIR, 'living-empty.jpg'),
      outputPath,
      width: 1024,
      height: 682,
      layers: [{ instances: [instance()], color: [255, 0, 0] }],
    });
    expect(imageDimensions(await readFile(outputPath))).toEqual({
      format: 'png',
      width: 1024,
      height: 682,
    });
  });
});
