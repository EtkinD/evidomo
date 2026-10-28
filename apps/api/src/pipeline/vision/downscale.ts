import sharp from 'sharp';
import type { PhotoMediaType } from './inventory.ts';

// The copy of a photo that Spark classifies. Image input tokens grow with resolution
// (docs/model-notes.md, P2-08), so photos above the step's `classification_long_edge_px` are
// downscaled; smaller ones are sent byte for byte, so equal input gives equal requests.

export interface ModelImage {
  readonly bytes: Uint8Array;
  readonly mediaType: PhotoMediaType;
  readonly width: number;
  readonly height: number;
}

/** JPEG quality of the downscaled copy (the stored photos use the same, P2-05). */
const QUALITY = 85;

export async function imageForClassification(
  image: ModelImage,
  longEdgePx: number,
): Promise<ModelImage> {
  if (Math.max(image.width, image.height) <= longEdgePx) return image;
  const { data, info } = await sharp(image.bytes, { failOn: 'error' })
    .resize({ width: longEdgePx, height: longEdgePx, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    mediaType: 'image/jpeg',
    width: info.width,
    height: info.height,
  };
}
