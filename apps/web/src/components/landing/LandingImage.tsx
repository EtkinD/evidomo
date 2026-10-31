import { useTranslations } from 'use-intl';
import { landingSrc, landingSrcSet, type LandingImage as Image } from '../../lib/landing-images';

// The file name of a variant set to its key in the `landing.images` messages (the alt texts).
const ALT_KEYS = {
  hero: 'hero',
  'interior-1': 'interior1',
  'interior-2': 'interior2',
  illustration: 'illustration',
} as const;

// Plain <img>: the production web image does not ship sharp, so next/image would not optimise at
// runtime. The variants are prebuilt (apps/web/scripts/build-landing-images.mjs).
export function LandingImage({
  image,
  sizes,
  priority = false,
  className = '',
}: {
  image: Image;
  sizes: string;
  /** The above-the-fold image: loaded eagerly with high fetch priority. Everything else is lazy. */
  priority?: boolean;
  className?: string;
}) {
  const t = useTranslations('landing.images');
  const largest = Math.max(...image.widths);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- prebuilt responsive variants, see above
    <img
      src={landingSrc(image, largest)}
      srcSet={landingSrcSet(image)}
      sizes={sizes}
      width={image.width}
      height={image.height}
      alt={t(ALT_KEYS[image.name as keyof typeof ALT_KEYS])}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding={priority ? 'sync' : 'async'}
      className={`h-auto w-full ${className}`}
    />
  );
}
