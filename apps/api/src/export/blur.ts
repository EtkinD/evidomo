import type { InventoryPhoto } from '@evidomo/shared';
import sharp from 'sharp';
import { PHOTO_OUTPUT } from '../media/image.ts';
import { isEnvironmentError } from '../media/upload-error.ts';
import { decodeSamMask, SamMaskError } from '../meta/sam-mask.ts';

// Privacy for exported originals (docs/architecture.md §5, "Export (P3-09)"). A photo is
// published only when the inventory's privacy check is complete, and then only after every
// stored privacy region (faces/people, license plates) is pixelated and blurred.
//
// Blur method: each region's SAM box, padded by 10% of its longer side plus 2 px, is cut out,
// reduced to about 8 blocks along its longer side (at least 8 px per block), scaled back with
// nearest-neighbour, and Gaussian-blurred with sigma = half a block. Only pixels inside the box
// are read, so nothing outside leaks in, and the result is close to a few flat colours. The box
// is used rather than the mask: the mask is a box-local raster, so the padded box covers every
// mask pixel by construction plus a margin for SAM's edge error. Masks are still decoded and
// size-checked: a payload that does not decode or fit its box means the stored region is
// inconsistent, and the photo is withheld.

/** A half-open pixel rectangle (`x0 ≤ x < x1`) in the stored photo's frame. */
export interface PixelBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export const BLUR_SETTINGS = {
  marginRatio: 0.1,
  marginPx: 2,
  blocksAlongLongerSide: 8,
  minBlockPx: 8,
} as const;

export type PrivacyPlan =
  | { readonly status: 'exportable'; readonly boxes: readonly PixelBox[] }
  | {
      readonly status: 'withheld';
      readonly reason: 'privacy_review' | 'privacy_failed' | 'privacy_regions_invalid';
    };

function regionFits(photo: InventoryPhoto, region: InventoryPhotoRegion): boolean {
  const { box, mask } = region;
  if (
    box.x0 < 0 ||
    box.y0 < 0 ||
    box.x1 > photo.width ||
    box.y1 > photo.height ||
    box.x1 <= box.x0 ||
    box.y1 <= box.y0
  ) {
    return false;
  }
  if (mask === null) return true;
  if (mask.width !== box.x1 - box.x0 || mask.height !== box.y1 - box.y0) return false;
  try {
    decodeSamMask(mask);
    return true;
  } catch (error) {
    if (error instanceof SamMaskError) return false;
    throw error;
  }
}

type InventoryPhotoRegion = Extract<
  InventoryPhoto['privacy']['phrases'][number],
  { status: 'checked' }
>['regions'][number];

/**
 * Decides from the inventory alone whether a photo may be exported, and which boxes to blur.
 * Fail-closed: `review` and `failed` photos are withheld, and so is a `masked` photo without a
 * readable region (it would otherwise be published unblurred).
 */
export function privacyPlan(photo: InventoryPhoto): PrivacyPlan {
  const { status, phrases } = photo.privacy;
  if (status === 'review') return { status: 'withheld', reason: 'privacy_review' };
  if (status === 'failed' || phrases.some((phrase) => phrase.status === 'failed')) {
    return { status: 'withheld', reason: 'privacy_failed' };
  }
  const regions = phrases.flatMap((phrase) => (phrase.status === 'checked' ? phrase.regions : []));
  if (status === 'masked' && regions.length === 0) {
    return { status: 'withheld', reason: 'privacy_regions_invalid' };
  }
  if (!regions.every((region) => regionFits(photo, region))) {
    return { status: 'withheld', reason: 'privacy_regions_invalid' };
  }
  // A `clear` photo has no regions; if one ever had, it would be blurred all the same.
  return { status: 'exportable', boxes: regions.map((region) => ({ ...region.box })) };
}

/** The box plus its safety margin, clipped to the image. */
export function paddedBox(box: PixelBox, width: number, height: number): PixelBox {
  const margin =
    Math.ceil(Math.max(box.x1 - box.x0, box.y1 - box.y0) * BLUR_SETTINGS.marginRatio) +
    BLUR_SETTINGS.marginPx;
  return {
    x0: Math.max(0, box.x0 - margin),
    y0: Math.max(0, box.y0 - margin),
    x1: Math.min(width, box.x1 + margin),
    y1: Math.min(height, box.y1 + margin),
  };
}

/** Decoding, blurring, or re-encoding the photo failed; the photo is withheld. */
export class PhotoBlurError extends Error {
  override name = 'PhotoBlurError';
}

export interface RawImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly channels: 3;
}

/**
 * Pixelates and blurs each padded box of a raw RGB image, in place on a copy. Pixels outside the
 * padded boxes are left byte for byte unchanged.
 */
export async function blurRawRegions(
  image: RawImage,
  boxes: readonly PixelBox[],
): Promise<RawImage> {
  const { width, height, channels } = image;
  const data = Buffer.from(image.data);
  for (const box of boxes) {
    const area = paddedBox(box, width, height);
    const w = area.x1 - area.x0;
    const h = area.y1 - area.y0;
    if (w <= 0 || h <= 0) throw new PhotoBlurError('A privacy region lies outside the photo');
    const block = Math.max(
      BLUR_SETTINGS.minBlockPx,
      Math.ceil(Math.max(w, h) / BLUR_SETTINGS.blocksAlongLongerSide),
    );
    const raw = { raw: { width, height, channels } } as const;
    const coarse = await sharp(data, raw)
      .extract({ left: area.x0, top: area.y0, width: w, height: h })
      .resize({
        width: Math.max(1, Math.ceil(w / block)),
        height: Math.max(1, Math.ceil(h / block)),
        fit: 'fill',
        kernel: 'cubic',
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    // A separate pipeline: sharp applies only the last resize of a pipeline.
    const patch = await sharp(coarse.data, {
      raw: { width: coarse.info.width, height: coarse.info.height, channels },
    })
      .resize({ width: w, height: h, fit: 'fill', kernel: 'nearest' })
      .blur(Math.max(0.3, block / 2))
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (patch.info.width !== w || patch.info.height !== h || patch.info.channels !== channels) {
      throw new PhotoBlurError('The blurred patch has an unexpected size');
    }
    const rowBytes = w * channels;
    for (let row = 0; row < h; row += 1) {
      patch.data.copy(
        data,
        ((area.y0 + row) * width + area.x0) * channels,
        row * rowBytes,
        (row + 1) * rowBytes,
      );
    }
  }
  return { data, width, height, channels };
}

export interface BlurredPhoto {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Blurs every box of a stored photo and re-encodes it like an upload (sRGB JPEG q85 mozjpeg,
 * no metadata). The stored photo is already metadata-free (P2-05), so nothing is carried over.
 * Throws `PhotoBlurError` for an undecodable photo or a frame that does not match the inventory.
 */
export async function blurPhoto(
  jpeg: Uint8Array,
  frame: { readonly width: number; readonly height: number },
  boxes: readonly PixelBox[],
): Promise<BlurredPhoto> {
  try {
    const decoded = await sharp(jpeg, { failOn: 'error' })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      decoded.info.width !== frame.width ||
      decoded.info.height !== frame.height ||
      decoded.info.channels !== 3
    ) {
      throw new PhotoBlurError('The photo does not match the inventory frame');
    }
    const blurred = await blurRawRegions(
      { data: decoded.data, width: frame.width, height: frame.height, channels: 3 },
      boxes,
    );
    const encoded = await sharp(blurred.data, {
      raw: { width: blurred.width, height: blurred.height, channels: 3 },
    })
      .jpeg({ quality: PHOTO_OUTPUT.quality, mozjpeg: true })
      .toBuffer();
    return {
      bytes: new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
      width: blurred.width,
      height: blurred.height,
    };
  } catch (error) {
    if (error instanceof PhotoBlurError) throw error;
    // A missing native binary or exhausted memory is ours to retry, not the photo's fault.
    if (isEnvironmentError(error)) throw error;
    throw new PhotoBlurError('The photo could not be blurred', { cause: error });
  }
}
