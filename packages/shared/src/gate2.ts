import { z } from 'zod';
import {
  claimAuditCategorySchema,
  claimAuditFlagSourceSchema,
  claimAuditStopReasonSchema,
} from './claim-audit.ts';
import { claimFindingCodeSchema, claimValidationReportSchema } from './claims.ts';
import { copyVariantKindSchema } from './copy.ts';
import { runStatusSchema, validatorResultSchema, verifierVerdictSchema } from './domain.ts';
import { FACT_CONFLICTS_GATE_STATES, gateFactSchema } from './gates.ts';
import { integrityOutcomeSchema } from './integrity.ts';
import {
  STAGED_IMAGE_LABEL,
  stagingFailureReasonSchema,
  stagingOperationIdSchema,
  stagingOperationKindSchema,
} from './staging.ts';
import { photoFailureReasonSchema } from './vision.ts';

// Gate 2 API contracts (docs/architecture.md §5 "Gate 2 API (P3-08)"): the final copy draft with
// its remaining claim-audit flags, the staged images the integrity check offers, the operator's
// decisions on both, and the sign-off that releases the run into export. Copy text, problems, and
// suggestions describe the property (personal-data scope): returned to the run's owner only,
// never logged or put into events.

/** The post-gate copy and image selection P3-09 exports, written when the pack is approved. */
export const APPROVED_PACK_ARTIFACT_KIND = 'approved_pack';

const count = z.int().nonnegative();
const decidedAt = z.iso.datetime({ offset: true });

/** Path parameters of the Gate 2 routes (the bare run route reuses `gateRunParamsSchema`). */
export const claimAuditClaimParamsSchema = z.strictObject({ runId: z.uuid(), claimId: z.uuid() });
export const claimAuditImageParamsSchema = z.strictObject({
  runId: z.uuid(),
  artifactId: z.uuid(),
});

/** Same bound as a stored copy segment (`copySegmentSchema.text`). */
export const CLAIM_EDIT_MAX_LENGTH = 2000;

/**
 * Edited segment text: whitespace collapsed and trimmed exactly like the creative step stores
 * copy, then 1–2,000 characters. The raw input is bounded first so normalization stays cheap.
 */
const editedClaimTextSchema = z
  .string()
  .max(CLAIM_EDIT_MAX_LENGTH * 4)
  .transform((text) => text.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1).max(CLAIM_EDIT_MAX_LENGTH));

/**
 * `PUT /api/runs/:runId/gates/claim-audit/claims/:claimId/decision`, for a claim with at least
 * one remaining flag. One decision covers every flag of the claim.
 *
 * - `accept`: publish the segment as written (the operator overrides the flags).
 * - `edit`: publish `text` instead. The citations stay the claim's own; the text must pass the
 *   claim validator against them (else 400 `claim_edit_rejected` with the findings).
 * - `remove`: drop the segment from the published copy.
 */
export const claimDecisionRequestSchema = z.discriminatedUnion('choice', [
  z.strictObject({ choice: z.literal('accept') }),
  z.strictObject({ choice: z.literal('edit'), text: editedClaimTextSchema }),
  z.strictObject({ choice: z.literal('remove') }),
]);
export type ClaimDecisionRequest = z.input<typeof claimDecisionRequestSchema>;
export type ParsedClaimDecisionRequest = z.output<typeof claimDecisionRequestSchema>;

/**
 * `PUT /api/runs/:runId/gates/claim-audit/images/:artifactId/decision`, for a staged image the
 * integrity check names as final: `accept` publishes it (labeled, next to its original),
 * `reject` keeps the original only.
 */
export const stagedImageDecisionRequestSchema = z.discriminatedUnion('choice', [
  z.strictObject({ choice: z.literal('accept') }),
  z.strictObject({ choice: z.literal('reject') }),
]);
export type StagedImageDecisionRequest = z.infer<typeof stagedImageDecisionRequestSchema>;

/** `POST /api/runs/:runId/gates/claim-audit/approve`: no body, or an empty object. */
export const claimAuditApproveRequestSchema = z.strictObject({}).optional();

/**
 * `decisions.edited_value` of an `edit` on a claim: the published text and the validator's
 * report on it against the claim's citations, which passed when the decision was recorded.
 */
export const claimEditSchema = z
  .strictObject({
    text: z.string().min(1).max(CLAIM_EDIT_MAX_LENGTH),
    validation: claimValidationReportSchema,
  })
  .refine((edit) => edit.validation.result === 'pass', {
    path: ['validation'],
    message: 'A stored edit passed the claim validator',
  });
export type ClaimEdit = z.infer<typeof claimEditSchema>;

/** A claim's decision as the gate reads it back; null while the claim is open. */
export const claimGateDecisionSchema = z.discriminatedUnion('choice', [
  z.strictObject({ choice: z.literal('accept'), decidedAt }),
  z.strictObject({
    choice: z.literal('edit'),
    text: z.string().min(1).max(CLAIM_EDIT_MAX_LENGTH),
    decidedAt,
  }),
  z.strictObject({ choice: z.literal('remove'), decidedAt }),
]);
export type ClaimGateDecision = z.infer<typeof claimGateDecisionSchema>;

export const stagedImageGateDecisionSchema = z.strictObject({
  choice: z.enum(['accept', 'reject']),
  decidedAt,
});
export type StagedImageGateDecision = z.infer<typeof stagedImageGateDecisionSchema>;

/** One remaining claim-audit flag, without the addressing the segment already carries. */
export const claimAuditGateFlagSchema = z.strictObject({
  source: claimAuditFlagSourceSchema,
  category: claimAuditCategorySchema,
  code: claimFindingCodeSchema.nullable(),
  problem: z.string().min(1),
  suggestion: z.string().min(1).nullable(),
  carried: z.boolean(),
});
export type ClaimAuditGateFlag = z.infer<typeof claimAuditGateFlagSchema>;

/** One segment of the final draft. Unflagged segments are published as written. */
export const claimAuditGateSegmentSchema = z.strictObject({
  /** The `claims` row: the target of a claim decision. */
  claimId: z.uuid(),
  /** Position across the draft (`claims.segment_index`). */
  index: count,
  /** Position within the variant (the flag's `segment`). */
  position: count,
  paragraph: count,
  text: z.string().min(1),
  factIds: z.array(z.string().min(1)),
  validatorResult: validatorResultSchema.nullable(),
  verifierVerdict: verifierVerdictSchema.nullable(),
  /** Remaining flags; empty for a segment that needs no decision. */
  flags: z.array(claimAuditGateFlagSchema),
  /** Null for an unflagged segment, and for a flagged one not decided yet. */
  decision: claimGateDecisionSchema.nullable(),
});
export type ClaimAuditGateSegment = z.infer<typeof claimAuditGateSegmentSchema>;

export const claimAuditGateVariantSchema = z.strictObject({
  kind: copyVariantKindSchema,
  segments: z.array(claimAuditGateSegmentSchema),
});
export type ClaimAuditGateVariant = z.infer<typeof claimAuditGateVariantSchema>;

/** One integrity attempt, summarized for display (the full verdict stays in the artifact). */
export const integrityAttemptSummarySchema = z.strictObject({
  attempt: z.union([z.literal(1), z.literal(2)]),
  status: z.enum(['checked', 'unchecked', 'edit_failed']),
  /** The image checked; null for `edit_failed`. Failed attempts are shown, never offered. */
  stagedArtifactId: z.uuid().nullable(),
  passed: z.boolean(),
  /** Fixed-element classes that failed (`checked` only). */
  failedClasses: z.array(z.string().min(1)),
  /** Edit privacy check (`checked` only): false when a person was drawn in. */
  privacyPassed: z.boolean().nullable(),
  /** `unchecked`: which image could not be segmented. */
  target: z.enum(['original', 'edit']).nullable(),
  /** `unchecked` / `edit_failed`: the closed reason code. */
  reason: z.union([photoFailureReasonSchema, stagingFailureReasonSchema]).nullable(),
});
export type IntegrityAttemptSummary = z.infer<typeof integrityAttemptSummarySchema>;

/** A staged image offered for approval: the integrity check's final image for its photo. */
export const claimAuditGateImageSchema = z.strictObject({
  /** The `staged_image` artifact (file + record): the target of an image decision. */
  artifactId: z.uuid(),
  /** The original photo (`materials.id`), shown side by side. */
  materialId: z.uuid(),
  operation: z.strictObject({ id: stagingOperationIdSchema, kind: stagingOperationKindSchema }),
  /** Must be shown with the image wherever it appears. */
  disclosureLabel: z.literal(STAGED_IMAGE_LABEL),
  stored: z.strictObject({ width: z.int().positive(), height: z.int().positive() }),
  integrity: z.strictObject({
    outcome: integrityOutcomeSchema.exclude(['fallback_original']),
    /** The passing verdict's largest aspect change and per-class counts. */
    aspectRatioChange: z.number().nonnegative(),
    classes: z.array(
      z.strictObject({
        label: z.string().min(1),
        originalCount: count,
        editCount: count,
        worstMatchedIoU: z.number().min(0).max(1).nullable(),
      }),
    ),
    attempts: z.array(integrityAttemptSummarySchema).min(1).max(2),
  }),
  decision: stagedImageGateDecisionSchema.nullable(),
});
export type ClaimAuditGateImage = z.infer<typeof claimAuditGateImageSchema>;

/** A staged photo the integrity check rejected: only the original is published. */
export const integrityFallbackSchema = z.strictObject({
  materialId: z.uuid(),
  operationId: stagingOperationIdSchema,
  attempts: z.array(integrityAttemptSummarySchema).min(1).max(2),
});
export type IntegrityFallback = z.infer<typeof integrityFallbackSchema>;

/**
 * What the current decisions do to the copy; never blocking (the publication checklist judges
 * the pack). `market_fact_unmentioned`: removing segments dropped every mention of a market fact
 * the variant mentioned before (the removed claims that cited it are listed). `variant_empty`:
 * every segment of the variant is removed; the export publishes no text for it.
 */
export const claimAuditWarningSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('market_fact_unmentioned'),
    variant: copyVariantKindSchema,
    factKey: z.string().min(1),
    /** The market profile requires the fact (`required: true`). */
    required: z.boolean(),
    removedClaimIds: z.array(z.uuid()).min(1),
  }),
  z.strictObject({ kind: z.literal('variant_empty'), variant: copyVariantKindSchema }),
]);
export type ClaimAuditWarning = z.infer<typeof claimAuditWarningSchema>;

/** Same meaning as Gate 1's states (`released` = signed off and resumed). */
export const CLAIM_AUDIT_GATE_STATES = FACT_CONFLICTS_GATE_STATES;
export const claimAuditGateStateSchema = z.enum(CLAIM_AUDIT_GATE_STATES);
export type ClaimAuditGateState = z.infer<typeof claimAuditGateStateSchema>;

/** `GET /api/runs/:runId/gates/claim-audit` (200); every write returns it too. */
export const claimAuditGateResponseSchema = z.strictObject({
  runId: z.uuid(),
  runStatus: runStatusSchema,
  state: claimAuditGateStateSchema,
  /** Null before the gate is reached. */
  claimAuditArtifactId: z.uuid().nullable(),
  finalDraftArtifactId: z.uuid().nullable(),
  /** Null when the run has no integrity record (nothing is offered then). */
  integrityChecksArtifactId: z.uuid().nullable(),
  /** Set once the pack is approved. */
  approvedPackArtifactId: z.uuid().nullable(),
  outputLanguage: z.string().nullable(),
  stopReason: claimAuditStopReasonSchema.nullable(),
  /** The audit history: one entry per audited draft. */
  passes: z.array(
    z.strictObject({
      draftArtifactId: z.uuid(),
      revision: count,
      flagCount: count,
      auditedSegments: count,
      carriedSegments: count,
    }),
  ),
  counts: z.strictObject({
    flaggedClaims: count,
    openClaims: count,
    offeredImages: count,
    openImages: count,
  }),
  /** Claims and images still undecided; approval needs 0. Always 0 once released. */
  openCount: count,
  approval: z.strictObject({ decidedBy: z.uuid(), decidedAt }).nullable(),
  variants: z.array(claimAuditGateVariantSchema),
  /** Every fact the final draft cites, with provenance for the evidence inspector (P4-07). */
  facts: z.array(gateFactSchema),
  images: z.array(claimAuditGateImageSchema),
  integrityFallbacks: z.array(integrityFallbackSchema),
  warnings: z.array(claimAuditWarningSchema),
});
export type ClaimAuditGateResponse = z.infer<typeof claimAuditGateResponseSchema>;

/** Where a published segment's text comes from. */
export const APPROVED_SEGMENT_ORIGINS = ['unflagged', 'accepted', 'edited'] as const;

/**
 * Content of the `approved_pack` artifact (step ID `gate:claim_audit`), written once in the
 * approval transaction: the copy and image selection exactly as approved. P3-09 exports from
 * this artifact (plus the stored originals and staged files it names), never from the
 * decisions directly.
 */
export const approvedPackContentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    claimAuditArtifactId: z.uuid(),
    finalDraftArtifactId: z.uuid(),
    integrityChecksArtifactId: z.uuid().nullable(),
    outputLanguage: z.string().regex(/^[a-z]{2}$/),
    /** `portal`, then `social`; a variant whose segments were all removed is empty. */
    variants: z
      .array(
        z.strictObject({
          kind: copyVariantKindSchema,
          segments: z.array(
            z.strictObject({
              claimId: z.uuid(),
              index: count,
              paragraph: count,
              text: z.string().min(1).max(CLAIM_EDIT_MAX_LENGTH),
              factIds: z.array(z.string().min(1)).min(1),
              origin: z.enum(APPROVED_SEGMENT_ORIGINS),
            }),
          ),
        }),
      )
      .length(2),
    removedClaimIds: z.array(z.uuid()),
    /** One entry per staged photo of the integrity record, in its order. */
    images: z.array(
      z.strictObject({
        materialId: z.uuid(),
        operationId: stagingOperationIdSchema,
        integrityOutcome: integrityOutcomeSchema,
        /** The image offered at Gate 2; null for `fallback_original`. */
        offeredArtifactId: z.uuid().nullable(),
        decision: z.enum(['accept', 'reject']).nullable(),
        /** The staged image to publish (labeled, next to the original), or null. */
        publishedArtifactId: z.uuid().nullable(),
      }),
    ),
    warnings: z.array(claimAuditWarningSchema),
    approvedBy: z.uuid(),
    approvedAt: decidedAt,
  })
  .superRefine((pack, ctx) => {
    if (pack.variants.some((variant, i) => variant.kind !== (i === 0 ? 'portal' : 'social'))) {
      ctx.addIssue({ code: 'custom', path: ['variants'], message: 'portal, then social' });
    }
    pack.images.forEach((image, i) => {
      const consistent =
        (image.offeredArtifactId === null) === (image.decision === null) &&
        (image.offeredArtifactId === null) === (image.integrityOutcome === 'fallback_original') &&
        image.publishedArtifactId ===
          (image.decision === 'accept' ? image.offeredArtifactId : null);
      if (!consistent) {
        ctx.addIssue({
          code: 'custom',
          path: ['images', i],
          message: 'Only an accepted offered image is published',
        });
      }
    });
  });
export type ApprovedPackContent = z.infer<typeof approvedPackContentSchema>;
