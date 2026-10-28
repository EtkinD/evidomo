import { z } from 'zod';
import { claimFindingCodeSchema } from './claims.ts';
import type { VerifierVerdict } from './domain.ts';
import { reconciliationModelRunSchema } from './reconciliation.ts';

// The claim audit (docs/architecture.md §5 step 8, "Verification (P3-06)"): what the verifier
// and the claim validator found in each copy draft, the revision loops, and the flags that
// remain for Gate 2. Shared because Gate 2 (P3-08), the publication checklist (P3-07), export,
// and the web app read it. Problems and suggestions quote and rewrite copy, so the artifact and
// the `claims.verifier_details` it mirrors have the copy's personal-data scope: they cascade with
// the project and never go into events or logs.

export const CLAIM_AUDIT_ARTIFACT_KIND = 'claim_audit';

/**
 * Rubric categories, a closed set because the verifier prompt implements each:
 *
 * - `claim_support`: the wording says more than, or something other than, the cited facts
 *   (an added feature or condition, a reinterpreted fact, a count from a photo presence). The
 *   claim validator's findings (numbers, citations) are filed here too.
 * - `unverifiable_superlative`, `investment_promise`, `exclusionary`: the market profile's
 *   `flagged_phrasing` categories (superlatives and promises are checked in every market).
 * - `area_basis`: built from the profile's area facts and bases: an area figure must be what
 *   it is presented as (living area only on the profile's living-area basis).
 */
export const CLAIM_AUDIT_CATEGORIES = [
  'claim_support',
  'unverifiable_superlative',
  'investment_promise',
  'exclusionary',
  'area_basis',
] as const;
export const claimAuditCategorySchema = z.enum(CLAIM_AUDIT_CATEGORIES);
export type ClaimAuditCategory = z.infer<typeof claimAuditCategorySchema>;

/**
 * The audited text groups: the listing copy's `portal` and `social` variants; `qa` is reserved
 * for buyer Q&A cards (P3-03), which verification audits once that step stores them.
 */
export const CLAIM_AUDIT_VARIANTS = ['portal', 'social', 'qa'] as const;
export const claimAuditVariantSchema = z.enum(CLAIM_AUDIT_VARIANTS);
export type ClaimAuditVariant = z.infer<typeof claimAuditVariantSchema>;

/** Who raised a flag: the code-level claim validator (P3-02) or the model verifier. */
export const CLAIM_AUDIT_FLAG_SOURCES = ['validator', 'verifier'] as const;
export const claimAuditFlagSourceSchema = z.enum(CLAIM_AUDIT_FLAG_SOURCES);
export type ClaimAuditFlagSource = z.infer<typeof claimAuditFlagSourceSchema>;

/** Why the revision loop ended. */
export const CLAIM_AUDIT_STOP_REASONS = [
  /** The last audited draft has no flags. */
  'clean',
  /** `max_revision_loops` revisions were made and flags remain. */
  'loop_limit',
  /** A budget cap was reached during a revision loop; the last audited draft stands. */
  'budget',
  /**
   * A revision or its audit failed for a model reason (an error response, a truncated or
   * unusable answer, a timeout, after any fallback); the last audited draft stands.
   */
  'revision_failed',
] as const;
export const claimAuditStopReasonSchema = z.enum(CLAIM_AUDIT_STOP_REASONS);
export type ClaimAuditStopReason = z.infer<typeof claimAuditStopReasonSchema>;

const count = z.int().nonnegative();

/** Bounds shared by the model output check and the stored flag. */
export const CLAIM_AUDIT_LIMITS = { problem: 500, suggestion: 2000, rule: 2000 } as const;

/** One problem in one segment of one audited draft. */
export const claimAuditFlagSchema = z
  .strictObject({
    source: claimAuditFlagSourceSchema,
    category: claimAuditCategorySchema,
    /** The claim validator's finding code; null for verifier flags. */
    code: claimFindingCodeSchema.nullable(),
    /** The draft artifact the segment belongs to (a `listing_copy`, later also Q&A cards). */
    artifactId: z.uuid(),
    variant: claimAuditVariantSchema,
    /** 0-based position within the variant, across paragraphs (the revision flag's `segment`). */
    segment: count,
    /** The segment's index in its artifact, `claims.segment_index`. */
    segmentIndex: count,
    /** The `claims` row: what Gate 2 decides (`decisions.target_kind = 'claim'`). */
    claimId: z.uuid(),
    /** One English sentence for the operator: the words at fault and the rule they break. */
    problem: z.string().min(1).max(CLAIM_AUDIT_LIMITS.problem),
    /** The verifier's rewrite in the copy's language, or null (validator flags never have one). */
    suggestion: z.string().min(1).max(CLAIM_AUDIT_LIMITS.suggestion).nullable(),
    /**
     * A verifier flag taken over from an earlier pass because the segment is unchanged (same
     * variant, text, and citations); the segment was not sent to the model again.
     */
    carried: z.boolean(),
  })
  .superRefine((flag, ctx) => {
    if ((flag.source === 'validator') !== (flag.code !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['code'],
        message: 'Exactly validator flags have a code',
      });
    }
    if (flag.source === 'validator' && (flag.suggestion !== null || flag.carried)) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'Validator flags are recomputed per draft and carry no suggestion',
      });
    }
  });
export type ClaimAuditFlag = z.infer<typeof claimAuditFlagSchema>;

/** One rubric rule as the verifier received it (built from the market profile). */
export const claimAuditRuleSchema = z.strictObject({
  category: claimAuditCategorySchema,
  rule: z.string().min(1).max(CLAIM_AUDIT_LIMITS.rule),
});
export type ClaimAuditRule = z.infer<typeof claimAuditRuleSchema>;

/** Model flags that code refused, by reason; never stored as flags. */
export const claimAuditDroppedSchema = z.strictObject({
  /** A segment ID the request did not contain. */
  unknownSegment: count,
  /** A segment sent as context only (unchanged since an earlier pass). */
  notAudited: count,
  /** A category outside the request's rubric. */
  unknownCategory: count,
  /** A problem that is empty after trimming. */
  emptyProblem: count,
  /** The same segment, category, and problem twice. */
  duplicate: count,
});
export type ClaimAuditDropped = z.infer<typeof claimAuditDroppedSchema>;

/** One audit of one draft: the validator's report plus one verifier call (or none). */
export const claimAuditPassSchema = z.strictObject({
  /** The `listing_copy` artifact audited. */
  draftArtifactId: z.uuid(),
  /** The draft's `revision` (0 = the creative step's copy). */
  revision: count,
  segments: count,
  /** Segments the verifier judged in this pass. */
  auditedSegments: count,
  /** Unchanged segments whose earlier verdict was kept without a model call. */
  carriedSegments: count,
  /** Null when no segment needed the model (every segment unchanged since an earlier pass). */
  modelRun: reconciliationModelRunSchema.nullable(),
  /** Validator flags first, then verifier flags, in segment order. */
  flags: z.array(claimAuditFlagSchema),
  dropped: claimAuditDroppedSchema,
});
export type ClaimAuditPass = z.infer<typeof claimAuditPassSchema>;

/**
 * Content of the `claim_audit` artifact: one per verification step. Gate 2 lists
 * `remainingFlags` (each points at its claim) and shows `passes` as the history.
 */
export const claimAuditContentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    promptVersion: z.int().positive(),
    outputLanguage: z.string().regex(/^[a-z]{2}$/),
    market: z.strictObject({ id: z.string().min(1), version: z.int().positive() }),
    rubric: z.array(claimAuditRuleSchema).min(1),
    maxRevisionLoops: count,
    stopReason: claimAuditStopReasonSchema,
    /** The creative step's copy (revision 0). */
    initialDraftArtifactId: z.uuid(),
    /** The last audited draft: what Gate 2 reviews and export publishes. */
    finalDraftArtifactId: z.uuid(),
    /** In revision order: the initial draft, then each revision. */
    passes: z.array(claimAuditPassSchema).min(1),
    /** The final draft's flags (= the last pass's flags), for Gate 2. */
    remainingFlags: z.array(claimAuditFlagSchema),
    counts: z.strictObject({
      passes: count,
      revisions: count,
      verifierCalls: count,
      remainingFlags: count,
      remainingValidatorFlags: count,
      remainingVerifierFlags: count,
      /** Claims of the final draft with at least one remaining flag. */
      flaggedClaims: count,
      finalClaims: count,
    }),
    /** Some pass's verdict came from the definition's fallback model. */
    fallbackUsed: z.boolean(),
  })
  .superRefine((content, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const last = content.passes.at(-1);
    content.passes.forEach((pass, i) => {
      if (pass.revision !== i) issue(['passes', i, 'revision'], 'Passes are revisions 0..n');
      if (pass.auditedSegments + pass.carriedSegments !== pass.segments) {
        issue(['passes', i], 'Every segment is audited or carried');
      }
      if (pass.flags.some((flag) => flag.artifactId !== pass.draftArtifactId)) {
        issue(['passes', i, 'flags'], 'A flag points at another draft');
      }
    });
    if (content.passes[0]?.draftArtifactId !== content.initialDraftArtifactId) {
      issue(['initialDraftArtifactId'], 'The first pass audits the initial draft');
    }
    if (last !== undefined) {
      if (last.draftArtifactId !== content.finalDraftArtifactId) {
        issue(['finalDraftArtifactId'], 'The last pass audits the final draft');
      }
      if (JSON.stringify(last.flags) !== JSON.stringify(content.remainingFlags)) {
        issue(['remainingFlags'], "The remaining flags are the last pass's flags");
      }
    }
    const { counts } = content;
    const remaining = content.remainingFlags;
    if (
      counts.passes !== content.passes.length ||
      counts.revisions !== content.passes.length - 1 ||
      counts.revisions > content.maxRevisionLoops ||
      counts.verifierCalls !== content.passes.filter((pass) => pass.modelRun !== null).length ||
      counts.remainingFlags !== remaining.length ||
      counts.remainingValidatorFlags !== remaining.filter((f) => f.source === 'validator').length ||
      counts.remainingVerifierFlags !== remaining.filter((f) => f.source === 'verifier').length ||
      counts.flaggedClaims !== new Set(remaining.map((flag) => flag.claimId)).size ||
      counts.finalClaims !== last?.segments
    ) {
      issue(['counts'], 'Counts must match the passes and remaining flags');
    }
    if ((content.stopReason === 'clean') !== (remaining.length === 0)) {
      issue(['stopReason'], 'clean means no remaining flags');
    }
    if (content.stopReason === 'loop_limit' && counts.revisions !== content.maxRevisionLoops) {
      issue(['stopReason'], 'loop_limit means every allowed revision was made');
    }
    const fallback = content.passes.some((pass) => pass.modelRun?.fallbackFrom != null);
    if (content.fallbackUsed !== fallback) issue(['fallbackUsed'], 'Fallback flag');
  });
export type ClaimAuditContent = z.infer<typeof claimAuditContentSchema>;

/**
 * `claims.verifier_details` for one claim of an audited draft. The verdict column is
 * `unsupported` with a `claim_support` flag, `flagged` with any other verifier flag, else
 * `supported`; validator findings stay in `validator_details`.
 */
export const claimVerifierDetailsSchema = z.strictObject({
  promptVersion: z.int().positive(),
  /** The step's `claim_audit` artifact. */
  auditArtifactId: z.uuid(),
  /** The pass that audited this draft (= its revision). */
  pass: count,
  /** True when the verdict was taken over from an earlier pass (segment unchanged). */
  carried: z.boolean(),
  flags: z.array(
    z.strictObject({
      category: claimAuditCategorySchema,
      problem: z.string().min(1).max(CLAIM_AUDIT_LIMITS.problem),
      suggestion: z.string().min(1).max(CLAIM_AUDIT_LIMITS.suggestion).nullable(),
    }),
  ),
});
export type ClaimVerifierDetails = z.infer<typeof claimVerifierDetailsSchema>;

/** The verdict a claim's verifier flags amount to (see {@link claimVerifierDetailsSchema}). */
export function verifierVerdictFor(
  flags: readonly { readonly category: ClaimAuditCategory }[],
): VerifierVerdict {
  if (flags.some((flag) => flag.category === 'claim_support')) return 'unsupported';
  return flags.length > 0 ? 'flagged' : 'supported';
}
