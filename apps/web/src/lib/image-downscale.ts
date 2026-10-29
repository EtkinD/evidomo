import { UPLOAD_LIMITS } from '@evidomo/shared';

export const DOWNSCALE_QUALITY = 0.85;

/** Why a photo could not be prepared on the device. */
export type DownscaleFailure = 'heic_unreadable' | 'undecodable' | 'encode_failed';

export class DownscaleError extends Error {
  override name = 'DownscaleError';
  readonly failure: DownscaleFailure;

  constructor(failure: DownscaleFailure, options?: ErrorOptions) {
    super(`Photo could not be prepared (${failure})`, options);
    this.failure = failure;
  }
}

export interface Size {
  width: number;
  height: number;
}

/** Fits the long edge to `maxLongEdge`; smaller images are never enlarged. */
export function fitLongEdge(
  width: number,
  height: number,
  maxLongEdge: number = UPLOAD_LIMITS.photoLongEdgePx,
): Size {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decodeWithBitmap(file: Blob): Promise<Decoded> {
  // `from-image` applies the EXIF orientation, so the canvas is upright.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    release: () => bitmap.close(),
  };
}

function decodeWithImageElement(file: Blob): Promise<Decoded> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () =>
      resolve({
        // Browsers that decode <img> orient it by EXIF as well (image-orientation: from-image is
        // the default).
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        release: () => URL.revokeObjectURL(url),
      });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image element could not decode the file'));
    };
    image.src = url;
  });
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await decodeWithBitmap(file);
    } catch {
      // Safari decodes HEIC through <img> but not always through createImageBitmap; fall back.
    }
  }
  return decodeWithImageElement(file);
}

function isHeic(file: Blob & { name?: string }): boolean {
  return /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name ?? '');
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) reject(new DownscaleError('encode_failed'));
        else resolve(blob);
      },
      'image/jpeg',
      DOWNSCALE_QUALITY,
    );
  });
}

/**
 * Decodes a photo, draws it at most `UPLOAD_LIMITS.photoLongEdgePx` on the long edge, and
 * re-encodes it as JPEG. This also turns HEIC into JPEG where the browser can decode it (Safari)
 * and drops EXIF (GPS) before the file leaves the device. Rejects with `DownscaleError`.
 *
 * The whole image is decoded before it is scaled, so a very large photo needs width x height x 4
 * bytes of memory (about 430 MB for 108 MP); a phone that cannot afford it fails as `undecodable`.
 */
export async function downscaleImage(file: Blob & { name?: string }): Promise<Blob> {
  let decoded: Decoded;
  try {
    decoded = await decode(file);
  } catch (cause) {
    throw new DownscaleError(isHeic(file) ? 'heic_unreadable' : 'undecodable', { cause });
  }
  const canvas = document.createElement('canvas');
  try {
    if (decoded.width < 1 || decoded.height < 1) throw new DownscaleError('undecodable');
    const size = fitLongEdge(decoded.width, decoded.height);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new DownscaleError('encode_failed');
    // JPEG has no alpha: transparent PNG areas would turn black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(decoded.source, 0, 0, size.width, size.height);
    return await toJpeg(canvas);
  } finally {
    decoded.release();
    // iOS Safari caps the total canvas memory of a page; a zero-size canvas frees its backing
    // store at once instead of whenever the garbage collector gets to it.
    canvas.width = 0;
    canvas.height = 0;
  }
}
