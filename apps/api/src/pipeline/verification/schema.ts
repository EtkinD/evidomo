import { z } from 'zod';

// Verification (claim audit) contracts, first measured in P1-03 to size the step's cost
// (docs/model-notes.md). The starting point for P3-06, not its final shape.

const factValueSchema = z.union([z.number(), z.string()]);

export const verificationInputSchema = z.object({
  outputLanguage: z.string().min(2),
  /** The Verified Fact Sheet after Gate 1; IDs are what copy segments cite. */
  facts: z.array(
    z.object({
      id: z.string().regex(/^VF\d{2,3}$/),
      key: z.string().min(1),
      value: factValueSchema,
      unit: z.string().nullable(),
      basis: z.string().nullable(),
    }),
  ),
  marketRules: z.array(z.object({ id: z.string().min(1), rule: z.string().min(1) })),
  /** Segments that already passed the code-level claim validator (known IDs, exact numbers). */
  segments: z.array(
    z.object({
      id: z.string().regex(/^S\d{2,3}$/),
      artifact: z.enum(['portal', 'social', 'qa']),
      text: z.string().min(1),
      factIds: z.array(z.string()).min(1),
    }),
  ),
});

export type VerificationInput = z.infer<typeof verificationInputSchema>;

export const VERIFICATION_ISSUE_CATEGORIES = [
  'unsupported_claim',
  'superlative',
  'investment_promise',
  'exclusionary',
  'market_rule',
  'other',
] as const;

// Strict json_schema: nullable instead of optional, no constraints strict mode cannot express.
export const verificationOutputSchema = z.object({
  audits: z.array(
    z.object({
      segmentId: z.string(),
      verdict: z.enum(['supported', 'unsupported', 'flagged']),
      issues: z.array(
        z.object({
          category: z.enum(VERIFICATION_ISSUE_CATEGORIES),
          explanation: z.string(),
        }),
      ),
      suggestedRevision: z
        .string()
        .nullable()
        .describe('rewritten segment that the cited facts support, or null if none is needed'),
    }),
  ),
});

export type VerificationOutput = z.infer<typeof verificationOutputSchema>;
