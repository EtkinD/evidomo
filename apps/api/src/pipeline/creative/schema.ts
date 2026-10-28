import { COPY_VARIANTS, photoSubjectSchema, reconciledValueSchema } from '@evidomo/shared';
import { z } from 'zod';

// The copy request's user message and the model's structured output (strict json_schema:
// every property required, `.nullable()` never `.optional()`, and no bounds the server would be
// trusted to enforce; code checks the rest, see check.ts).

const catalogId = z.string().regex(/^VF\d{2,3}$/);

/** A segment as the model writes it, with catalog IDs. */
export const modelSegmentSchema = z.object({
  text: z.string(),
  factIds: z.array(catalogId),
});
export type ModelSegment = z.infer<typeof modelSegmentSchema>;

/** A complete draft in the model's terms: also how a revision sends the previous draft back. */
export const copyDraftSchema = z.object({
  portal: z.object({ paragraphs: z.array(z.object({ segments: z.array(modelSegmentSchema) })) }),
  social: z.object({ segments: z.array(modelSegmentSchema) }),
});
export type CopyDraft = z.infer<typeof copyDraftSchema>;

/** A problem found in a draft (P3-02 validator or P3-06 verifier), addressed by position. */
export const copyRevisionFlagSchema = z.strictObject({
  variant: z.enum(COPY_VARIANTS),
  /** 0-based segment position within the variant, across paragraphs. */
  segment: z.int().nonnegative(),
  /** One operator-readable sentence: what is wrong and, if known, what would fix it. */
  problem: z.string().min(1).max(500),
});
export type CopyRevisionFlag = z.infer<typeof copyRevisionFlagSchema>;

export const copyRevisionSchema = z.strictObject({
  draft: copyDraftSchema,
  flags: z.array(copyRevisionFlagSchema).min(1),
});
export type CopyRevision = z.infer<typeof copyRevisionSchema>;

/** The user message: everything the copy may draw on, as compact JSON. */
export const copyInputSchema = z.strictObject({
  language: z.strictObject({ code: z.string().regex(/^[a-z]{2}$/), name: z.string().min(1) }),
  tone: z.string().min(1).max(200).nullable(),
  market: z.strictObject({
    id: z.string().min(1),
    currency: z.string().nullable(),
    units: z.strictObject({ area: z.string(), volume: z.string().nullable() }),
    areaBases: z.array(z.strictObject({ id: z.string(), label: z.string() })),
  }),
  facts: z
    .array(
      z.strictObject({
        id: catalogId,
        key: z.string().min(1),
        label: z.string().nullable(),
        value: reconciledValueSchema,
        unit: z.string().nullable(),
        basis: z.string().nullable(),
        presence: z.boolean(),
        seenIn: z.array(photoSubjectSchema),
      }),
    )
    .min(1),
  photos: z
    .strictObject({ cover: photoSubjectSchema.nullable(), rooms: z.array(photoSubjectSchema) })
    .nullable(),
  revision: copyRevisionSchema.nullable(),
});
export type CopyInput = z.infer<typeof copyInputSchema>;

/**
 * The output schema for one request. `factIds` is an enum of the request's catalog IDs, so
 * Meta's strict mode keeps the model from citing an ID that does not exist; code checks again.
 */
export function copyOutputSchema(catalogIds: readonly string[]) {
  const [first, ...rest] = catalogIds;
  if (first === undefined) throw new Error('A copy request needs at least one citable fact');
  const segment = z.object({
    text: z.string().describe('one sentence or clause'),
    factIds: z
      .array(z.enum([first, ...rest]))
      .describe('IDs of every fact this segment relies on; at least one'),
  });
  return z.object({
    portal: z.object({ paragraphs: z.array(z.object({ segments: z.array(segment) })) }),
    social: z.object({ segments: z.array(segment) }),
  });
}
