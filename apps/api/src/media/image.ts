import { readFile, stat } from 'node:fs/promises';
import { UPLOAD_LIMITS, type PhotoSourceFormat } from '@evidomo/shared';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { isEnvironmentError, UploadRejectedError } from './upload-error.ts';

export type { PhotoSourceFormat };

/** Output encoding: JPEG for universal support in portals, browsers, and vision models. */
export const PHOTO_OUTPUT = { mimeType: 'image/jpeg', extension: 'jpg', quality: 85 } as const;

export interface PhotoOptions {
  readonly maxBytes?: number;
  readonly maxPixels?: number;
  readonly longEdgePx?: number;
}

export interface ProcessedPhoto {
  /** Re-encoded JPEG: oriented, at most `longEdgePx` on the long edge, sRGB, no metadata. */
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly sourceFormat: PhotoSourceFormat;
  /** Upload dimensions after EXIF orientation. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

// ISO BMFF brands of HEIF-family files (HEIC/HEIF from phones, AVIF).
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
  'avif',
  'avis',
]);

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * Identifies the container from its magic bytes. This runs before any decoder sees the file, so
 * libvips never parses formats we do not accept (SVG, PDF, TIFF, GIF, ...).
 */
export function sniffImageFormat(bytes: Uint8Array): PhotoSourceFormat | 'heif' | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && pngSignature.every((byte, i) => bytes[i] === byte)) return 'png';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8, 12))) {
    return 'heif';
  }
  return undefined;
}

const UNDECODABLE_MESSAGE = 'The photo could not be read; it may be damaged or incomplete.';

function decodeFailure(error: unknown): unknown {
  // A full disk or a missing native binary is our fault, not the uploader's.
  if (isEnvironmentError(error)) return error;
  return new UploadRejectedError('undecodable', UNDECODABLE_MESSAGE, { cause: error });
}

/**
 * Validates an uploaded photo by its content and re-encodes it. sharp writes no metadata unless
 * asked, so the output carries no EXIF (GPS, camera, timestamps), XMP, IPTC, comments, or ICC
 * profile; pixels are converted to sRGB through the embedded profile first.
 *
 * HEIC is refused: sharp's prebuilt libvips ships libheif with the AV1 decoder only (HEVC is
 * patent-encumbered), so it can read AVIF but not iPhone HEIC. The web app converts on the
 * device (P4-03), where the browser can decode HEIC.
 */
export async function processPhoto(
  inputPath: string,
  options: PhotoOptions = {},
): Promise<ProcessedPhoto> {
  const maxBytes = options.maxBytes ?? UPLOAD_LIMITS.photoMaxBytes;
  const maxPixels = options.maxPixels ?? UPLOAD_LIMITS.photoMaxPixels;
  const longEdgePx = options.longEdgePx ?? UPLOAD_LIMITS.photoLongEdgePx;

  const { size } = await stat(inputPath);
  if (size === 0) throw new UploadRejectedError('empty_file', 'The photo file is empty.');
  if (size > maxBytes) {
    throw new UploadRejectedError(
      'file_too_large',
      `The photo is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
    );
  }

  // Decoding from memory, not the path: libvips' file cache could otherwise keep the deleted
  // temp file open after processing.
  const input = await readFile(inputPath);
  const sniffed = sniffImageFormat(input);
  if (sniffed === 'heif') {
    throw new UploadRejectedError(
      'heic_not_supported',
      'HEIC/HEIF photos are not supported. Upload JPEG, PNG, or WebP, or set the camera to "Most Compatible".',
    );
  }
  if (sniffed === undefined) {
    throw new UploadRejectedError(
      'unsupported_format',
      'Unsupported photo format. Upload JPEG, PNG, or WebP.',
    );
  }

  // `failOn: 'error'` rejects corrupt and truncated data. `metadata()` only parses headers; the
  // pixel limit is checked on its result for a clear message, and `limitInputPixels` makes the
  // decoder refuse independently (decompression bombs).
  const decodeOptions = { failOn: 'error', limitInputPixels: maxPixels } as const;

  let metadata: Metadata;
  try {
    metadata = await sharp(input, { failOn: 'error', limitInputPixels: false }).metadata();
  } catch (error) {
    throw decodeFailure(error);
  }
  if (metadata.format !== sniffed) {
    throw new UploadRejectedError(
      'unsupported_format',
      'The photo content does not match its format.',
    );
  }
  if (metadata.width * metadata.height > maxPixels) {
    throw new UploadRejectedError(
      'too_many_pixels',
      `The photo has more than ${Math.floor(maxPixels / 1_000_000)} megapixels; downscale it first.`,
    );
  }

  let output: { data: Buffer; info: OutputInfo };
  try {
    output = await sharp(input, { ...decodeOptions, autoOrient: true })
      .resize({
        width: longEdgePx,
        height: longEdgePx,
        fit: 'inside',
        withoutEnlargement: true,
      })
      // JPEG has no alpha: composite transparent PNG/WebP areas onto white, not black.
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: PHOTO_OUTPUT.quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw decodeFailure(error);
  }

  return {
    data: output.data,
    width: output.info.width,
    height: output.info.height,
    sourceFormat: sniffed,
    sourceWidth: metadata.autoOrient.width,
    sourceHeight: metadata.autoOrient.height,
  };
}
