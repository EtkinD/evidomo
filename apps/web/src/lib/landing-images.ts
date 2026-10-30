// Responsive variants built by apps/web/scripts/build-landing-images.mjs. Widths and sizes must match the
// files in public/images/landing; a test checks that every listed file exists.

export type LandingImageKey = 'hero' | 'interior1' | 'interior2' | 'illustration';

export interface LandingImage {
  readonly name: string;
  readonly widths: readonly number[];
  /** Intrinsic size of the largest variant; the browser reserves this ratio before it loads. */
  readonly width: number;
  readonly height: number;
  readonly alt: string;
}

const STANDARD = [640, 1280, 1920] as const;

export const LANDING_IMAGES = {
  hero: {
    name: 'hero',
    widths: STANDARD,
    width: 1920,
    height: 1280,
    alt: 'A bright canal-house living room with a green-cream brick wall, a beige sofa, a green armchair, and a potted plant by the window',
  },
  interior1: {
    name: 'interior-1',
    widths: STANDARD,
    width: 1920,
    height: 1280,
    alt: 'An oak herringbone floor meeting terracotta tiles, with leaf shadows and a yellow pot holding an olive branch',
  },
  interior2: {
    name: 'interior-2',
    widths: STANDARD,
    width: 1920,
    height: 1280,
    alt: 'A limewashed brick fireplace with an oak mantel, eucalyptus in a terracotta pot, and birch logs',
  },
  illustration: {
    name: 'illustration',
    widths: [640, 1280, 1600],
    width: 1600,
    height: 1600,
    alt: 'An illustration of a white house with a rounded cream roof, an open yellow door, and a green plant',
  },
} as const satisfies Record<LandingImageKey, LandingImage>;

export function landingSrc(image: LandingImage, width: number): string {
  return `/images/landing/${image.name}-${width}.webp`;
}

export function landingSrcSet(image: LandingImage): string {
  return image.widths.map((w) => `${landingSrc(image, w)} ${w}w`).join(', ');
}
