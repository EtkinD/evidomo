import { useTranslations } from 'use-intl';
import {
  samplePhotoSrc,
  samplePhotoSrcSet,
  type SamplePhotoId,
  SAMPLE_PHOTOS,
} from '../../lib/sample-run';

// Plain <img>: the production web image does not ship sharp, so next/image would not optimise at
// runtime. The variants are prebuilt (apps/web/scripts/build-sample-run-images.mjs). Every sample
// photo is below the fold, so all of them load lazily.
export function SamplePhoto({
  id,
  sizes,
  className = '',
}: {
  id: SamplePhotoId;
  sizes: string;
  className?: string;
}) {
  const t = useTranslations('landing.photos');
  const photo = SAMPLE_PHOTOS[id];
  const largest = Math.max(...photo.widths);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- prebuilt responsive variants, see above
    <img
      src={samplePhotoSrc(photo, largest)}
      srcSet={samplePhotoSrcSet(photo)}
      sizes={sizes}
      width={photo.width}
      height={photo.height}
      alt={t(id)}
      loading="lazy"
      decoding="async"
      className={`h-auto w-full ${className}`}
    />
  );
}
