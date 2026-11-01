import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { blurPhoto } from './blur.ts';
import { burnStagedLabel } from './label.ts';
import { PACK_IMAGE_MAX_WIDTH_PX, packImage, PackImageError } from './print-image.ts';
import { syntheticPhoto } from './testing.ts';

// The HTML pack's print-sized copies: size rule, metadata, determinism, and that the privacy
// blur and the burned-in staged label survive the downscale (the copy is derived from the export
// bytes, never from the original).

const WIDE = { width: 2048, height: 1536 } as const;
const BOX = { x0: 600, y0: 400, x1: 900, y1: 600 } as const;

async function luma(bytes: Uint8Array): Promise<{ data: Buffer; width: number }> {
  const { data, info } = await sharp(bytes).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width };
}

/** Mean absolute difference between horizontal neighbours in a box of the packed image. */
async function roughness(
  bytes: Uint8Array,
  box: { x0: number; y0: number; x1: number; y1: number },
  scale: number,
): Promise<number> {
  const { data, width } = await luma(bytes);
  let sum = 0;
  let count = 0;
  for (let y = Math.round(box.y0 * scale); y < Math.round(box.y1 * scale); y += 1) {
    for (let x = Math.round(box.x0 * scale); x < Math.round(box.x1 * scale) - 1; x += 1) {
      sum += Math.abs((data[y * width + x] ?? 0) - (data[y * width + x + 1] ?? 0));
      count += 1;
    }
  }
  return sum / count;
}

describe('packImage', () => {
  let wide: Uint8Array;

  beforeAll(async () => {
    wide = await syntheticPhoto([200, 180, 150], [], WIDE);
  });

  it('scales a wide photo to the 88 mm column at about 230 dpi, keeping the aspect ratio', async () => {
    expect(PACK_IMAGE_MAX_WIDTH_PX).toBe(800);
    const out = await packImage(wide);
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 800, 600]);
    expect(out.byteLength).toBeLessThan(wide.byteLength);
  });

  it('limits a portrait photo by width too: it prints as wide as any other', async () => {
    const portrait = await syntheticPhoto([200, 180, 150], [], { width: 1536, height: 2048 });
    const meta = await sharp(await packImage(portrait)).metadata();
    expect([meta.width, meta.height]).toEqual([800, 1067]);
  });

  it('carries no metadata', async () => {
    const meta = await sharp(await packImage(wide)).metadata();
    expect([meta.exif, meta.xmp, meta.icc, meta.iptc]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('embeds a photo that is not wider than the cap unchanged', async () => {
    const small = await syntheticPhoto([200, 180, 150], [], { width: 640, height: 480 });
    expect(await packImage(small)).toBe(small);
    const exact = await syntheticPhoto([200, 180, 150], [], { width: 800, height: 600 });
    expect(await packImage(exact)).toBe(exact);
  });

  it('gives the same bytes for the same input', async () => {
    expect(Buffer.from(await packImage(wide)).equals(Buffer.from(await packImage(wide)))).toBe(
      true,
    );
  });

  it('keeps the privacy blur: a blurred region stays smooth after the downscale', async () => {
    const patterned = await syntheticPhoto([200, 180, 150], [BOX], WIDE);
    const blurred = (await blurPhoto(patterned, WIDE, [BOX])).bytes;
    const scale = PACK_IMAGE_MAX_WIDTH_PX / WIDE.width;
    const before = await roughness(await packImage(patterned), BOX, scale);
    const after = await roughness(await packImage(blurred), BOX, scale);
    // The checkerboard is the stand-in for a face or plate: the copy of the blurred export must
    // not bring detail back.
    expect(before).toBeGreaterThan(40);
    expect(after).toBeLessThan(before / 5);
  });

  it('keeps the burned-in staged label', async () => {
    const plain = await syntheticPhoto([230, 215, 190], [], WIDE);
    const labeled = await burnStagedLabel(plain);
    const scale = PACK_IMAGE_MAX_WIDTH_PX / WIDE.width;
    const { left, top, width, height } = labeled.badge;
    const mean = async (bytes: Uint8Array): Promise<number> => {
      const { data, width: w } = await luma(bytes);
      let sum = 0;
      let count = 0;
      for (let y = Math.round(top * scale); y < Math.round((top + height) * scale); y += 1) {
        for (let x = Math.round(left * scale); x < Math.round((left + width) * scale); x += 1) {
          sum += data[y * w + x] ?? 0;
          count += 1;
        }
      }
      return sum / count;
    };
    const withLabel = await mean(await packImage(labeled.bytes));
    const withoutLabel = await mean(await packImage(plain));
    expect(withoutLabel).toBeGreaterThan(150);
    expect(withLabel).toBeLessThan(withoutLabel / 2);
  });

  it('refuses bytes that are not an image', async () => {
    await expect(packImage(new TextEncoder().encode('not a jpeg'))).rejects.toThrow(PackImageError);
  });
});
