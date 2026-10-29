import {
  claimAuditCategorySchema,
  claimAuditRuleSchema,
  claimAuditVariantSchema,
  photoSubjectSchema,
  reconciledValueSchema,
  type ClaimAuditCategory,
} from '@evidomo/shared';
import { z } from 'zod';

// The verification step's user message and the model's structured output (strict json_schema:
// every property required, `.nullable()` never `.optional()`). The P1-03 sizing prototype
// (`schema.ts`) returned one audit per segment; the step asks for flags only, because Wonder's
// answer, not its reasoning, dominated the prototype's cost and a clean segment needs no text.

/** `P01`, `S01`, `Q01`: variant initial and 1-based position within the variant. */
export const auditSegmentIdSchema = z.string().regex(/^[PSQ]\d{2,3}$/);

export const verificationStepInputSchema = z.strictObject({
  language: z.strictObject({ code: z.string().regex(/^[a-z]{2}$/), name: z.string().min(1) }),
  market: z.strictObject({
    id: z.string().min(1),
    currency: z.string().nullable(),
    units: z.strictObject({ area: z.string(), volume: z.string().nullable() }),
    areaBases: z.array(z.strictObject({ id: z.string(), label: z.string() })),
  }),
  rubric: z.array(claimAuditRuleSchema).min(1),
  /** The catalog facts cited anywhere in the copy (the only source of truth for it). */
  facts: z
    .array(
      z.strictObject({
        id: z.string().regex(/^VF\d{2,3}$/),
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
  copy: z
    .array(
      z.strictObject({
        variant: claimAuditVariantSchema,
        /**
         * Q&A only (P3-03): the card questions, by card; a Q&A segment's `paragraph` is its
         * card. Absent for copy variants, so a request without Q&A is the P3-06 request.
         */
        questions: z.array(z.string().min(1)).min(1).optional(),
        segments: z
          .array(
            z.strictObject({
              id: auditSegmentIdSchema,
              paragraph: z.int().nonnegative(),
              text: z.string().min(1),
              factIds: z.array(z.string().regex(/^VF\d{2,3}$/)).min(1),
              /** False: unchanged since an earlier pass, sent as context only. */
              audit: z.boolean(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});
export type VerificationStepInput = z.infer<typeof verificationStepInputSchema>;

/** A flag as the model returns it; code maps and checks it (`checkVerifierFlags`). */
export const modelAuditFlagSchema = z.object({
  segment: z.string(),
  category: z.string(),
  problem: z.string(),
  suggestion: z.string().nullable(),
});
export type ModelAuditFlag = z.infer<typeof modelAuditFlagSchema>;

export const modelAuditOutputSchema = z.object({ flags: z.array(modelAuditFlagSchema) });
export type ModelAuditOutput = z.infer<typeof modelAuditOutputSchema>;

/**
 * The output schema for one request: `segment` is an enum of the segments to audit and
 * `category` an enum of the rubric's categories, so Meta's strict mode already stops the model
 * from flagging a context segment or inventing a rule; code checks again.
 */
export function claimAuditOutputSchema(
  segmentIds: readonly string[],
  categories: readonly ClaimAuditCategory[],
) {
  const [firstSegment, ...otherSegments] = segmentIds;
  const [firstCategory, ...otherCategories] = categories;
  if (firstSegment === undefined) throw new Error('An audit request needs a segment to audit');
  if (firstCategory === undefined) throw new Error('An audit request needs a rubric');
  for (const category of categories) claimAuditCategorySchema.parse(category);
  return z.object({
    flags: z
      .array(
        z.object({
          segment: z
            .enum([firstSegment, ...otherSegments])
            .describe('id of a segment with "audit": true'),
          category: z
            .enum([firstCategory, ...otherCategories])
            .describe('the rubric category the words break'),
          problem: z
            .string()
            .describe('one English sentence: the exact words at fault and why they break the rule'),
          suggestion: z
            .string()
            .nullable()
            .describe(
              'the whole segment rewritten in the copy language so that its cited facts support it and it follows every rule; null if the claim should be dropped',
            ),
        }),
      )
      .describe('one entry per problem; empty when no audited segment breaks a rule'),
  });
}
