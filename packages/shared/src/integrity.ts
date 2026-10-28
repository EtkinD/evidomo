import { z } from 'zod';
import { stagingFailureReasonSchema, stagingOperationIdSchema } from './staging.ts';
import { photoFailureReasonSchema, samPhraseSchema } from './vision.ts';

// The integrity check of staged images (docs/architecture.md §5, step 7): each staged image is
// compared with its original on fixed elements (windows, doors, radiators) segmented by SAM.
// Shared because Gate 2 (P3-08) shows the verdicts next to each image, and the export (P3-09)
// and the web app may only offer a staged image this record names as final.

/** One per integrity step: the verdicts and the final image of every staged photo. */
export const INTEGRITY_CHECKS_ARTIFACT_KIND = 'integrity_checks';

/**
 * What a staged photo ends up as:
 * - `passed`: the staging step's image passed; it is final;
 * - `passed_on_retry`: it failed, the same declared operation was re-run once, and the new
 *   image (stored by the integrity step) passed; the new image is final;
 * - `fallback_original`: no staged image is offered for the photo, only the original. The first
 *   image and the retry both failed, the retry produced no image, or the check itself could not
 *   run (fail-closed: an unchecked edit is never offered).
 */
export const INTEGRITY_OUTCOMES = ['passed', 'passed_on_retry', 'fallback_original'] as const;
export const integrityOutcomeSchema = z.enum(INTEGRITY_OUTCOMES);
export type IntegrityOutcome = z.infer<typeof integrityOutcomeSchema>;

const ratio = z.number().min(0).max(1);
const count = z.int().nonnegative();
const pixels = z.int().positive();

/** A SAM box in pixels of its own image, half-open (`x0 ≤ x < x1`). */
const boxSchema = z.strictObject({
  x0: z.number().nonnegative(),
  y0: z.number().nonnegative(),
  x1: z.number().nonnegative(),
  y1: z.number().nonnegative(),
});

/**
 * One image's SAM results: instances per phrase (masks are not kept; boxes are what the
 * comparison uses and what Gate 2 can draw). An empty array means "segmented, none found".
 */
export const integritySegmentationSchema = z.strictObject({
  width: pixels,
  height: pixels,
  segments: z.record(
    z.string().min(1),
    z.array(z.strictObject({ box: boxSchema, score: ratio.nullable() })),
  ),
});
export type IntegritySegmentation = z.infer<typeof integritySegmentationSchema>;

const thresholdsSchema = z.strictObject({
  minIoU: ratio,
  minContainment: ratio,
  minAreaRatio: ratio,
  maxAspectRatioChange: z.number().nonnegative(),
});

const unmatchedSchema = z.strictObject({ index: count, bestIoU: ratio });

/** `IntegrityVerdict` of `apps/api/src/pipeline/integrity/compare.ts`, stored whole. */
export const integrityVerdictSchema = z.strictObject({
  passed: z.boolean(),
  aspectRatioChange: z.number().nonnegative(),
  failures: z.array(z.enum(['aspect_ratio_changed'])),
  failedClasses: z.array(z.string().min(1)),
  classes: z.array(
    z.strictObject({
      label: z.string().min(1),
      occlusionTolerant: z.boolean(),
      originalCount: count,
      editCount: count,
      countDelta: z.int(),
      matches: z.array(
        z.strictObject({
          original: count,
          edit: count,
          iou: ratio,
          containment: ratio,
          areaRatio: ratio,
          rule: z.enum(['iou', 'containment']),
        }),
      ),
      unmatchedOriginal: z.array(unmatchedSchema),
      unmatchedEdit: z.array(unmatchedSchema),
      worstMatchedIoU: ratio.nullable(),
      passed: z.boolean(),
      failures: z.array(z.enum(['count_changed', 'unmatched_original', 'unmatched_edit'])),
    }),
  ),
  thresholds: thresholdsSchema,
});
export type StoredIntegrityVerdict = z.infer<typeof integrityVerdictSchema>;

/** The edit's privacy phrases: any instance fails the attempt (the original was clear). */
const privacyCheckSchema = z.strictObject({
  passed: z.boolean(),
  phrases: z.array(z.strictObject({ phrase: samPhraseSchema, count })),
});

const attemptNumber = z.union([z.literal(1), z.literal(2)]);

/**
 * One checked image of a photo. Attempt 1 is the staging step's image; attempt 2 the retry.
 * - `checked`: segmented and compared; `passed` = the verdict and the privacy check passed;
 * - `unchecked`: a SAM call for the original or the edit failed for this photo (the reason is a
 *   closed code), so the edit cannot be offered;
 * - `edit_failed`: the retry edit produced no image (attempt 2 only).
 */
export const integrityAttemptSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('checked'),
    attempt: attemptNumber,
    /** The `staged_image` artifact checked (the retry's is stored by the integrity step). */
    stagedArtifactId: z.uuid(),
    passed: z.boolean(),
    edit: integritySegmentationSchema,
    verdict: integrityVerdictSchema,
    privacy: privacyCheckSchema,
  }),
  z.strictObject({
    status: z.literal('unchecked'),
    attempt: attemptNumber,
    stagedArtifactId: z.uuid(),
    /** Which image's segmentation failed. */
    target: z.enum(['original', 'edit']),
    reason: photoFailureReasonSchema,
  }),
  z.strictObject({
    status: z.literal('edit_failed'),
    attempt: z.literal(2),
    reason: stagingFailureReasonSchema,
  }),
]);
export type IntegrityAttempt = z.infer<typeof integrityAttemptSchema>;

export const integrityPhotoSchema = z
  .strictObject({
    materialId: z.uuid(),
    operationId: stagingOperationIdSchema,
    /** The original's fixed elements, segmented once and reused for the retry; null if failed. */
    original: integritySegmentationSchema.nullable(),
    attempts: z.array(integrityAttemptSchema).min(1).max(2),
    outcome: integrityOutcomeSchema,
    /**
     * The only `staged_image` artifact that may be offered for this photo (Gate 2, export);
     * null for `fallback_original`. Every other staged image of the photo stays stored for audit.
     */
    finalStagedArtifactId: z.uuid().nullable(),
  })
  .superRefine((photo, ctx) => {
    const last = photo.attempts.at(-1);
    const passedId = last?.status === 'checked' && last.passed ? last.stagedArtifactId : null;
    const expected: IntegrityOutcome =
      passedId === null ? 'fallback_original' : last?.attempt === 1 ? 'passed' : 'passed_on_retry';
    if (photo.outcome !== expected || photo.finalStagedArtifactId !== passedId) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'outcome and finalStagedArtifactId must follow from the last attempt',
      });
    }
    photo.attempts.forEach((attempt, i) => {
      if (attempt.attempt !== i + 1) {
        ctx.addIssue({ code: 'custom', path: ['attempts', i], message: 'attempts out of order' });
      }
    });
  });
export type IntegrityPhoto = z.infer<typeof integrityPhotoSchema>;

/**
 * Content of the `integrity_checks` artifact: one entry per staged photo of the run's
 * `staged_images` manifest, in manifest order, plus the settings the verdicts were made with.
 */
export const integrityChecksContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  segmentationModel: z.string().min(1),
  /** The staging step's `staged_images` artifact. */
  stagedImagesArtifactId: z.uuid(),
  fixedElements: z.array(
    z.strictObject({ phrase: samPhraseSchema, occlusionTolerant: z.boolean() }),
  ),
  thresholds: thresholdsSchema,
  editPrivacyPhrases: z.array(samPhraseSchema),
  counts: z.strictObject({
    photos: count,
    passed: count,
    passedOnRetry: count,
    fallbackOriginal: count,
    /** Retry edits sent to the image model. */
    retries: count,
    /** Photos whose check could not run (SAM failed for the original or an edit). */
    unchecked: count,
  }),
  photos: z.array(integrityPhotoSchema),
});
export type IntegrityChecksContent = z.infer<typeof integrityChecksContentSchema>;
