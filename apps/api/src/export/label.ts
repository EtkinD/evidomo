import { STAGED_IMAGE_LABEL } from '@evidomo/shared';
import sharp from 'sharp';
import { PHOTO_OUTPUT } from '../media/image.ts';
import { isEnvironmentError } from '../media/upload-error.ts';
import { STAGED_IMAGE_XMP } from '../pipeline/staging/encode.ts';

// The visible "Virtually staged" disclosure burned into an exported staged image, so a portal
// upload separated from the HTML pack still carries it. A dark badge in the bottom-left corner
// with the label drawn as SVG strokes.
//
// Why strokes, not `<text>`: librsvg renders text with system fonts through fontconfig, and the
// production image (`node:*-slim`) has no fonts installed, so a text label would silently render
// as nothing. The glyphs below cover exactly the label's characters; a missing glyph throws.
//
// Order: the badge is composited onto the decoded pixels, the result is encoded once as JPEG,
// and the encoder writes our XMP packet (IPTC DigitalSourceType) into that output. The input's
// metadata is not carried over, so the marker is the only metadata, as in P3-04.

/** Glyphs on a grid: baseline y = 10, x-height 4, ascender 0, descender 13. */
const GLYPHS: Readonly<Record<string, { readonly width: number; readonly d: string }>> = {
  V: { width: 6, d: 'M0 0L3 10L6 0' },
  i: { width: 1, d: 'M0.5 4V10M0.5 1.3V1.5' },
  r: { width: 3.5, d: 'M0 4V10M0 6.6Q0.6 4 3.5 4.2' },
  t: { width: 3, d: 'M1.1 1.5V8.6Q1.1 10 2.6 10M0 4H2.9' },
  u: { width: 4, d: 'M0 4V8Q0 10 2 10Q4 10 4 8M4 4V10' },
  a: { width: 4, d: 'M4 4V10M4 7A2 3 0 1 0 0 7A2 3 0 1 0 4 7' },
  l: { width: 1, d: 'M0.5 0V10' },
  y: { width: 4.4, d: 'M0 4L2.2 10M4.4 4L1.8 11.6Q1.3 13 0.2 13' },
  s: {
    width: 3.8,
    d: 'M3.6 4.9Q3 4 1.9 4Q0.1 4 0.1 5.5Q0.1 6.9 1.9 7Q3.8 7.1 3.8 8.5Q3.8 10 1.9 10Q0.6 10 0 9.1',
  },
  g: { width: 4, d: 'M4 4V11Q4 13 2 13Q0.9 13 0.3 12.3M4 7A2 3 0 1 0 0 7A2 3 0 1 0 4 7' },
  e: { width: 4, d: 'M0.1 7.2H4Q4 4 2 4Q0 4 0 7Q0 10 2.1 10Q3.3 10 3.9 9.2' },
  d: { width: 4, d: 'M4 0V10M4 7A2 3 0 1 0 0 7A2 3 0 1 0 4 7' },
  ' ': { width: 2.4, d: '' },
};

const TRACKING = 1.3;
const STROKE = 1.25;
const PAD = { x: 3, top: 2.5, bottom: 1.5 };
const GLYPH_HEIGHT = 13;

/** The label could not be drawn or burned in; the staged image is withheld. */
export class StagedLabelError extends Error {
  override name = 'StagedLabelError';
}

function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Badge size in glyph units for `text`. */
function badgeUnits(text: string): { width: number; height: number } {
  let width = 0;
  [...text].forEach((char, i) => {
    const glyph = GLYPHS[char];
    if (glyph === undefined) throw new StagedLabelError('The label has a character without glyph');
    width += glyph.width + (i > 0 ? TRACKING : 0);
  });
  return {
    width: width + 2 * PAD.x + STROKE,
    height: GLYPH_HEIGHT + PAD.top + PAD.bottom + STROKE,
  };
}

export interface LabelBadge {
  readonly svg: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The badge for an image of `width × height`: about 1/300 of the shorter side per glyph unit
 * (cap height ~3.3% of it), in the bottom-left corner with a 2.5% margin, scaled down to fit
 * narrow images. Deterministic text, no `<text>` element.
 */
export function stagedLabelBadge(
  width: number,
  height: number,
  text: string = STAGED_IMAGE_LABEL,
): LabelBadge {
  const units = badgeUnits(text);
  const margin = Math.round(Math.min(width, height) * 0.025);
  const scale = Math.min(
    Math.max(1.2, Math.min(width, height) / 300),
    (width - 2 * margin) / units.width,
  );
  if (!(scale >= 0.8) || height - 2 * margin < units.height * scale) {
    throw new StagedLabelError('The image is too small for a legible label');
  }
  const pixelWidth = Math.ceil(units.width * scale);
  const pixelHeight = Math.ceil(units.height * scale);
  let x = 0;
  const paths = [...text].flatMap((char, i) => {
    const glyph = GLYPHS[char];
    if (glyph === undefined) throw new StagedLabelError('The label has a character without glyph');
    if (i > 0) x += TRACKING;
    const at = x;
    x += glyph.width;
    return glyph.d === '' ? [] : [`<path transform="translate(${num(at)} 0)" d="${glyph.d}"/>`];
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" ` +
    `viewBox="0 0 ${num(units.width)} ${num(units.height)}" preserveAspectRatio="none">` +
    `<rect width="${num(units.width)}" height="${num(units.height)}" rx="2" fill="#111111" fill-opacity="0.8"/>` +
    `<g transform="translate(${num(PAD.x + STROKE / 2)} ${num(PAD.top + STROKE / 2)})" fill="none" ` +
    `stroke="#ffffff" stroke-width="${num(STROKE)}" stroke-linecap="round" stroke-linejoin="round">` +
    `${paths.join('')}</g></svg>`;
  return {
    svg,
    left: margin,
    top: height - margin - pixelHeight,
    width: pixelWidth,
    height: pixelHeight,
  };
}

export interface LabeledImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly badge: Omit<LabelBadge, 'svg'>;
}

/**
 * Burns the disclosure badge into a staged JPEG and re-encodes it (sRGB JPEG q85 mozjpeg) with
 * the IPTC DigitalSourceType XMP marker. Throws `StagedLabelError` for an undecodable image.
 */
export async function burnStagedLabel(jpeg: Uint8Array): Promise<LabeledImage> {
  try {
    const decoded = await sharp(jpeg, { failOn: 'error' })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = decoded.info;
    const badge = stagedLabelBadge(width, height);
    const encoded = await sharp(decoded.data, { raw: { width, height, channels: 3 } })
      .composite([{ input: Buffer.from(badge.svg), left: badge.left, top: badge.top }])
      .jpeg({ quality: PHOTO_OUTPUT.quality, mozjpeg: true })
      .withXmp(STAGED_IMAGE_XMP)
      .toBuffer();
    return {
      bytes: new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
      width,
      height,
      badge: { left: badge.left, top: badge.top, width: badge.width, height: badge.height },
    };
  } catch (error) {
    if (error instanceof StagedLabelError) throw error;
    if (isEnvironmentError(error)) throw error;
    throw new StagedLabelError('The staged image could not be labeled', { cause: error });
  }
}
