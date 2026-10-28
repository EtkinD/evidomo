import { z } from 'zod';
import { reconciliationModelRunSchema } from './reconciliation.ts';

// Listing copy (docs/architecture.md §5 step 5, §6): the portal description and the social
// caption as claim segments, each citing the facts that support it. Shared because the claim
// validator (P3-02), verification (P3-06), Gate 2 (P3-08), export (P3-09), and the web app read
// it. Copy text describes the property, so the artifact and its `claims` rows have the run's
// personal-data scope (they cascade with the project) and never go into events or logs.

export const LISTING_COPY_ARTIFACT_KIND = 'listing_copy';

/** `portal`: the listing portal description; `social`: one Instagram/Facebook caption. */
export const COPY_VARIANTS = ['portal', 'social'] as const;
export const copyVariantKindSchema = z.enum(COPY_VARIANTS);
export type CopyVariantKind = z.infer<typeof copyVariantKindSchema>;

/**
 * The short, content-derived fact IDs the model cites (`VF01`, `VF02`, ...). Code maps each to
 * the stored facts behind it; the model never sees database IDs.
 */
export const copyCatalogIdSchema = z.string().regex(/^VF\d{2,3}$/);

/**
 * Result of the code-level language check on one variant: `match` (the output language's
 * function words dominate), `inconclusive` (too little text to tell), or `unchecked` (no word
 * list for the output language). A variant in another language never reaches an artifact.
 */
export const COPY_LANGUAGE_CHECKS = ['match', 'inconclusive', 'unchecked'] as const;
export const copyLanguageCheckSchema = z.enum(COPY_LANGUAGE_CHECKS);
export type CopyLanguageCheck = z.infer<typeof copyLanguageCheckSchema>;

const count = z.int().nonnegative();

/** One claim: a sentence or clause and every fact it relies on. */
export const copySegmentSchema = z.strictObject({
  /** Position across all variants of the artifact; `claims.segment_index`. */
  index: count,
  /** Paragraph within the variant (always 0 for the caption). */
  paragraph: count,
  text: z.string().min(1).max(2000),
  /** Catalog IDs as the model cited them, de-duplicated, in its order. */
  catalogIds: z.array(copyCatalogIdSchema).min(1),
  /** Every stored fact behind those catalog IDs; `claims.fact_ids`. */
  factIds: z.array(z.uuid()).min(1),
});
export type CopySegment = z.infer<typeof copySegmentSchema>;

export const copyVariantSchema = z.strictObject({
  kind: copyVariantKindSchema,
  languageCheck: copyLanguageCheckSchema,
  segments: z.array(copySegmentSchema).min(1),
});
export type CopyVariant = z.infer<typeof copyVariantSchema>;

/** A catalog ID and the stored facts it stands for (the provenance mapping, kept for audit). */
export const copyCatalogEntrySchema = z.strictObject({
  id: copyCatalogIdSchema,
  factIds: z.array(z.uuid()).min(1),
});
export type CopyCatalogEntry = z.infer<typeof copyCatalogEntrySchema>;

/** Deterministic repairs applied to the model's segments (docs/architecture.md §5 Creative). */
export const copyRepairsSchema = z.strictObject({
  /** Uncited segments joined to a cited segment of the same paragraph. */
  mergedUncited: count,
  /** Paragraphs without any cited segment, removed whole ("no source, no claim"). */
  droppedUncitedParagraphs: count,
  /** Segments whose text was empty after trimming. */
  droppedEmpty: count,
});
export type CopyRepairs = z.infer<typeof copyRepairsSchema>;

/**
 * Content of a `listing_copy` artifact. The creative step writes revision 0; verification
 * (P3-06) writes each revision as a new artifact pointing at the one it revises. Its segments
 * are stored again as `claims` rows (one per segment, `segment_index = index`), which the
 * validator, the verifier, and Gate 2 annotate.
 */
export const listingCopyContentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    promptVersion: z.int().positive(),
    modelRun: reconciliationModelRunSchema,
    outputLanguage: z.string().regex(/^[a-z]{2}$/),
    /** The office tone the copy was written in (snapshot of the project's office profile). */
    tone: z.string().max(200).nullable(),
    /** 0 for the creative step's copy; 1, 2, ... for verification's revisions. */
    revision: count,
    /** The artifact this revision rewrites; null for revision 0. */
    previousArtifactId: z.uuid().nullable(),
    catalog: z.array(copyCatalogEntrySchema).min(1),
    /** `portal` first, then `social`. */
    variants: z.array(copyVariantSchema).length(COPY_VARIANTS.length),
    repairs: copyRepairsSchema,
    counts: z.strictObject({
      catalogFacts: count,
      /** Catalog IDs cited by at least one segment. */
      citedCatalogFacts: count,
      segments: count,
    }),
  })
  .superRefine((content, ctx) => {
    content.variants.forEach((variant, i) => {
      if (variant.kind !== COPY_VARIANTS[i]) {
        ctx.addIssue({ code: 'custom', path: ['variants', i, 'kind'], message: 'Variant order' });
      }
    });
    const segments = content.variants.flatMap((variant) => variant.segments);
    segments.forEach((segment, i) => {
      if (segment.index !== i) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants'],
          message: 'Segment indexes must be 0..n-1',
        });
      }
    });
    const catalog = new Set(content.catalog.map((entry) => entry.id));
    if (segments.some((segment) => segment.catalogIds.some((id) => !catalog.has(id)))) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: 'A segment cites an unknown ID',
      });
    }
    if (content.counts.segments !== segments.length) {
      ctx.addIssue({ code: 'custom', path: ['counts', 'segments'], message: 'Segment count' });
    }
    if ((content.revision === 0) !== (content.previousArtifactId === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['previousArtifactId'],
        message: 'Exactly revisions after 0 point at the artifact they revise',
      });
    }
  });
export type ListingCopyContent = z.infer<typeof listingCopyContentSchema>;
