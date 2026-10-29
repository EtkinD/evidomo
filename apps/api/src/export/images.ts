import type {
  InventoryPhoto,
  IntegrityChecksContent,
  PhotoInventoryContent,
  StagedImageContent,
} from '@evidomo/shared';

// Which photos and staged images the export publishes, in which order (pure rules; the I/O is
// in `build.ts`). Docs: architecture.md §5, "Export (P3-09)".

export interface OrderedPhoto {
  readonly photo: InventoryPhoto;
  /** 1-based upload order (the inventory's order). */
  readonly uploadPosition: number;
}

/**
 * The inventory's photos by cover rank (1 = best, the cover); photos whose classification failed
 * have no rank and follow in upload order.
 */
export function exportPhotoOrder(inventory: PhotoInventoryContent): OrderedPhoto[] {
  const rank = (photo: InventoryPhoto): number =>
    photo.classification.status === 'ok' ? photo.classification.coverRank : Infinity;
  return inventory.photos
    .map((photo, i) => ({ photo, uploadPosition: i + 1 }))
    .sort((a, b) => rank(a.photo) - rank(b.photo) || a.uploadPosition - b.uploadPosition);
}

/** The person phrase the integrity check must have segmented on a published edit. */
export const STAGED_PERSON_PHRASE = 'person';

/**
 * Whether a Gate 2-approved staged image may be exported, from the records alone: it must be
 * the integrity record's final image for this photo, its last attempt must be the passing check
 * of exactly this image, that check must have segmented `person` and found no instance of any
 * privacy phrase, its record must link it to exactly the inventoried original, and the original
 * must be privacy-`clear` (staging never edits other photos; a masked original's masks would not
 * fit the re-rendered frame). Anything else withholds the staged image (fail-closed).
 */
export function isPublishableStaged(input: {
  readonly publishedArtifactId: string;
  readonly photo: InventoryPhoto;
  readonly integrity: IntegrityChecksContent | null;
  /** The `staged_image` record, or null when the artifact is not a valid one of the run. */
  readonly record: StagedImageContent | null;
}): boolean {
  const { publishedArtifactId, photo, integrity, record } = input;
  if (photo.privacy.status !== 'clear' || record === null || integrity === null) return false;
  const checked = integrity.photos.find(
    (entry) =>
      entry.finalStagedArtifactId === publishedArtifactId && entry.materialId === photo.materialId,
  );
  const last = checked?.attempts.at(-1);
  if (
    last?.status !== 'checked' ||
    last.stagedArtifactId !== publishedArtifactId ||
    !last.passed ||
    !last.privacy.passed
  ) {
    return false;
  }
  const phrases = last.privacy.phrases;
  if (
    !phrases.some((p) => p.phrase.toLowerCase() === STAGED_PERSON_PHRASE) ||
    phrases.some((p) => p.count !== 0)
  ) {
    return false;
  }
  return (
    record.original.materialId === photo.materialId &&
    record.original.sha256 === photo.materialSha256
  );
}

/** `photo-01.jpg` / `photo-01-staged.jpg` for the n-th exported photo (1-based). */
export function imageFileName(photoNumber: number, kind: 'original' | 'staged'): string {
  const number = String(photoNumber).padStart(2, '0');
  return kind === 'staged' ? `photo-${number}-staged.jpg` : `photo-${number}.jpg`;
}
