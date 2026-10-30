import { landingSrc, landingSrcSet, type LandingImage as Image } from '../../lib/landing-images';

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
  const largest = Math.max(...image.widths);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- prebuilt responsive variants, see above
    <img
      src={landingSrc(image, largest)}
      srcSet={landingSrcSet(image)}
      sizes={sizes}
      width={image.width}
      height={image.height}
      alt={image.alt}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding={priority ? 'sync' : 'async'}
      className={`h-auto w-full ${className}`}
    />
  );
}
