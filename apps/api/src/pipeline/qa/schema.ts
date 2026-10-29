import { photoSubjectSchema, reconciledValueSchema } from '@evidomo/shared';
import { z } from 'zod';
import { modelSegmentSchema } from '../creative/schema.ts';

// The Q&A request's user message and the model's structured output (strict json_schema: every
// property required, `.nullable()` never `.optional()`, no bounds the server would be trusted to
// enforce; code checks the rest, see check.ts). Answer segments have the copy's segment shape.

const catalogId = z.string().regex(/^VF\d{2,3}$/);

/** A complete set of cards in the model's terms: also how a revision sends the cards back. */
export const qaDraftSchema = z.object({
  cards: z.array(z.object({ question: z.string(), answer: z.array(modelSegmentSchema) })),
});
export type QaDraft = z.infer<typeof qaDraftSchema>;

/** A problem found in a card (P3-02 validator or P3-06 verifier), addressed by position. */
export const qaRevisionFlagSchema = z.strictObject({
  /** 0-based card position. */
  card: z.int().nonnegative(),
  /** 0-based segment position within the card's answer. */
  segment: z.int().nonnegative(),
  /** One operator-readable sentence: what is wrong and, if known, what would fix it. */
  problem: z.string().min(1).max(500),
});
export type QaRevisionFlag = z.infer<typeof qaRevisionFlagSchema>;

export const qaRevisionSchema = z.strictObject({
  draft: qaDraftSchema,
  flags: z.array(qaRevisionFlagSchema).min(1),
});
export type QaRevision = z.infer<typeof qaRevisionSchema>;

/** The user message: the verified facts as the copy sees them, without the photo context. */
export const qaInputSchema = z.strictObject({
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
  revision: qaRevisionSchema.nullable(),
});
export type QaInput = z.infer<typeof qaInputSchema>;

/**
 * The output schema for one request. `factIds` is an enum of the request's catalog IDs, so
 * Meta's strict mode keeps the model from citing an ID that does not exist; code checks again.
 */
export function qaOutputSchema(catalogIds: readonly string[]) {
  const [first, ...rest] = catalogIds;
  if (first === undefined) throw new Error('A Q&A request needs at least one citable fact');
  const segment = z.object({
    text: z.string().describe('one sentence or clause of the answer'),
    factIds: z
      .array(z.enum([first, ...rest]))
      .describe('IDs of every fact this segment relies on; at least one'),
  });
  return z.object({
    cards: z.array(
      z.object({
        question: z.string().describe('a neutral buyer question without numbers, ending with "?"'),
        answer: z.array(segment).describe('1 to 3 segments'),
      }),
    ),
  });
}
