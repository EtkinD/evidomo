import { z } from 'zod';
import { imageRegionSchema } from './domain.ts';

// Vision inventory (docs/architecture.md §5 step 3): per-photo classification by Spark, privacy
// masks and capped evidence regions by SAM. Shared because the service definition names the
// privacy phrases, the market profile lists the evidence objects, and the web app and the export
// read the stored inventory (evidence overlays, face and plate blurring).

/**
 * One SAM text prompt: a single noun phrase. SAM has no list syntax (commas, semicolons, and
 * `+` return zero matches) and treats `<…>` as box/point tokens (docs/model-notes.md, P1-05).
 * Mirrors `assertSamPhrase` in the api's meta module, so a bad phrase fails at boot, not mid-run.
 */
export const samPhraseSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\n\r,;+<>|]+$/, 'Expected one noun phrase without list or token characters');

/** Main room or subject of a photo. A closed set: cover ranking and room counts read it. */
export const PHOTO_SUBJECTS = [
  'living_room',
  'kitchen',
  'dining_room',
  'bedroom',
  'bathroom',
  'toilet',
  'hallway',
  'staircase',
  'study',
  'laundry_room',
  'storage_room',
  'attic',
  'basement',
  'balcony',
  'terrace',
  'garden',
  'garage',
  'exterior',
  'view',
  'floor_plan',
  'document',
  'common_area',
  'other',
] as const;
export const photoSubjectSchema = z.enum(PHOTO_SUBJECTS);
export type PhotoSubject = z.infer<typeof photoSubjectSchema>;

export const PHOTO_QUALITY_RATINGS = ['good', 'acceptable', 'poor'] as const;
export const photoQualityRatingSchema = z.enum(PHOTO_QUALITY_RATINGS);
export type PhotoQualityRating = z.infer<typeof photoQualityRatingSchema>;

export const PHOTO_QUALITY_ISSUES = [
  'blurry',
  'too_dark',
  'overexposed',
  'tilted',
  'cluttered',
  'obstructed',
  'personal_items',
  'text_or_watermark',
] as const;
export const photoQualityIssueSchema = z.enum(PHOTO_QUALITY_ISSUES);
export type PhotoQualityIssue = z.infer<typeof photoQualityIssueSchema>;

/**
 * How furnished an interior room is with movable furniture, as Spark judged it:
 * - `empty`: no movable furniture and no loose objects standing in the room; fixed installations,
 *   built-ins (wardrobes, kitchen units), sanitary fittings, radiators, appliances, light
 *   fittings, and window coverings do not count;
 * - `partly`: some movable furniture or loose objects, but the room is not set up for its use;
 * - `furnished`: the main furniture for the room's use is in place.
 * Staging furnishes `empty` rooms only (docs/architecture.md §5, Staging).
 */
export const FURNISHING_STATES = ['empty', 'partly', 'furnished'] as const;
export const furnishingStateSchema = z.enum(FURNISHING_STATES);
export type FurnishingState = z.infer<typeof furnishingStateSchema>;

/**
 * Subjects that are not an interior room, so furnishing does not apply and is stored as null
 * whatever the model answered. `other` is not listed: it may be an interior room.
 */
export const FURNISHING_NOT_APPLICABLE_SUBJECTS: ReadonlySet<PhotoSubject> = new Set<PhotoSubject>([
  'balcony',
  'terrace',
  'garden',
  'exterior',
  'view',
  'floor_plan',
  'document',
]);

/** Inclusive bounds of the per-photo cover suitability score. */
export const COVER_SCORE_RANGE = { min: 1, max: 10 } as const;

/**
 * Why a model call for one photo produced no usable result. Errors that a step retry could fix
 * (rate limits, 5xx, timeouts) are not photo failures: they fail the step execution instead.
 */
export const PHOTO_FAILURE_REASONS = [
  'invalid_output',
  'output_truncated',
  'incomplete_response',
  'rejected_input',
] as const;
export const photoFailureReasonSchema = z.enum(PHOTO_FAILURE_REASONS);
export type PhotoFailureReason = z.infer<typeof photoFailureReasonSchema>;

/**
 * Privacy state of one photo, for blurring at export:
 * - `clear`: every privacy phrase was segmented and found nothing, and Spark saw nothing either;
 * - `masked`: at least one region was found (blur its masks);
 * - `review`: SAM found nothing for a phrase that Spark reported as visible (a human decides);
 * - `failed`: a privacy segmentation failed, so the photo is NOT privacy-checked.
 * Only `clear` and `masked` photos are privacy-checked.
 */
export const PRIVACY_STATUSES = ['clear', 'masked', 'review', 'failed'] as const;
export const privacyStatusSchema = z.enum(PRIVACY_STATUSES);
export type PrivacyStatus = z.infer<typeof privacyStatusSchema>;

/**
 * What happened to an observation's evidence segmentation:
 * - `segmented`: SAM found at least one instance (regions stored);
 * - `not_found`: SAM was asked and found nothing (no fact is stored);
 * - `not_requested`: the run's evidence cap was reached;
 * - `not_segmentable`: an `other` observation, which has no configured SAM phrase;
 * - `failed`: the SAM call failed for this photo.
 */
export const EVIDENCE_STATUSES = [
  'segmented',
  'not_found',
  'not_requested',
  'not_segmentable',
  'failed',
] as const;
export const evidenceStatusSchema = z.enum(EVIDENCE_STATUSES);
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const PHOTO_INVENTORY_ARTIFACT_KIND = 'photo_inventory';

const count = z.int().nonnegative();
const pixel = z.int().nonnegative();
const text = (max: number) => z.string().min(1).max(max);

/** A SAM mask as returned on the wire (box-local raster); decode with `@meta-sam/parser`. */
export const storedSamMaskSchema = z.strictObject({
  encoding: z.enum(['one_bit', 'lossless']),
  width: z.int().positive(),
  height: z.int().positive(),
  /** The payload including its encoding marker (`!` or `~`). */
  payload: z.string().min(2),
});
export type StoredSamMask = z.infer<typeof storedSamMaskSchema>;

/**
 * One segmented instance. `box` is in pixels of the stored photo, half-open
 * (`x0 ≤ x < x1`); `region` is the same box normalized to 0..1 (rounded inward to 6 digits).
 * `mask` is `null` only for evidence instances beyond the run's mask cap.
 */
export const samRegionSchema = z
  .strictObject({
    objectId: count,
    score: z.number().min(0).max(1).nullable(),
    box: z.strictObject({ x0: pixel, y0: pixel, x1: pixel, y1: pixel }),
    region: imageRegionSchema,
    mask: storedSamMaskSchema.nullable(),
  })
  .refine((r) => r.box.x1 > r.box.x0 && r.box.y1 > r.box.y0, { message: 'Empty box' });
export type SamRegion = z.infer<typeof samRegionSchema>;

const classificationSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    subject: photoSubjectSchema,
    /** Short English name when `subject` is `other`, else null. */
    otherSubject: text(60).nullable(),
    /**
     * Null when unknown: furnishing does not apply to the subject
     * (`FURNISHING_NOT_APPLICABLE_SUBJECTS`), the model gave none, or the inventory predates the
     * field (prompt version 1, read as null). Null is never treated as `empty`.
     */
    furnishing: furnishingStateSchema.nullable().default(null),
    summary: text(300),
    quality: photoQualityRatingSchema,
    qualityIssues: z.array(photoQualityIssueSchema),
    coverScore: z.int().min(COVER_SCORE_RANGE.min).max(COVER_SCORE_RANGE.max),
    /** 1 = best cover candidate of the run; unique among classified photos. */
    coverRank: z.int().positive(),
    /** Fields changed by a deterministic repair (e.g. `cover_score`). */
    repairs: z.array(z.string().min(1).max(40)),
  }),
  z.strictObject({ status: z.literal('failed'), reason: photoFailureReasonSchema }),
]);

const privacyPhraseResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('checked'),
    phrase: samPhraseSchema,
    /** Whether Spark listed this subject as visible; null when the classification failed. */
    modelSaw: z.boolean().nullable(),
    regions: z.array(samRegionSchema),
  }),
  z.strictObject({
    status: z.literal('failed'),
    phrase: samPhraseSchema,
    modelSaw: z.boolean().nullable(),
    reason: photoFailureReasonSchema,
  }),
]);

const observationSchema = z.strictObject({
  /** The candidate fact key (`other:<object>`); unique within the photo. */
  key: z.string().regex(/^other:[a-z][a-z0-9_]{0,63}$/),
  /** The market's evidence object ID, or `other`. */
  object: z.string().min(1).max(64),
  label: text(200),
  detail: text(200),
  /** Instances Spark counted in this photo. */
  modelCount: z.int().positive(),
  /** Market fact keys this object can support (from the profile's evidence objects). */
  supports: z.array(z.string().min(1)),
  evidence: z.strictObject({
    status: evidenceStatusSchema,
    /** The SAM phrase sent, or null when no request was made. */
    phrase: samPhraseSchema.nullable(),
    /** Instances SAM returned (all of them, also those whose mask was not kept). */
    instanceCount: count.nullable(),
    regions: z.array(samRegionSchema),
    reason: photoFailureReasonSchema.nullable(),
  }),
  /** The fact's region: the union of the SAM boxes, or the whole photo without regions. */
  region: imageRegionSchema,
  /** A `photo_region` fact was stored for this observation (not for `not_found`). */
  factStored: z.boolean(),
});
export type StoredObservation = z.infer<typeof observationSchema>;

export const OBSERVATION_REJECTION_REASONS = [
  'invalid_other_name',
  'invalid_count',
  'duplicate',
  'too_many',
] as const;
export type ObservationRejectionReason = (typeof OBSERVATION_REJECTION_REASONS)[number];

const inventoryPhotoSchema = z.strictObject({
  materialId: z.uuid(),
  materialSha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.int().positive(),
  height: z.int().positive(),
  classification: classificationSchema,
  privacy: z.strictObject({
    status: privacyStatusSchema,
    phrases: z.array(privacyPhraseResultSchema).min(1),
  }),
  observations: z.array(observationSchema),
});
export type InventoryPhoto = z.infer<typeof inventoryPhotoSchema>;

/**
 * Content of the `photo_inventory` artifact (one per run and step). Facts from photos cite it as
 * `maskArtifactId`; the masks of a fact are those of the observation with the fact's key in the
 * photo with the fact's `materialId`. Summaries and details are model text about the property,
 * so the artifact has the run's personal-data scope (it cascades with the project).
 */
export const photoInventoryContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  promptVersion: z.int().positive(),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  maxOutputTokens: z.int().positive(),
  segmentationModel: z.string().min(1),
  privacyPhrases: z.array(samPhraseSchema).min(1),
  evidence: z.strictObject({
    /** `max_evidence_masks`: cap on evidence SAM requests and on stored evidence masks per run. */
    cap: count,
    /** (photo, object) pairs Spark observed that have a SAM phrase. */
    candidateCount: count,
    requestCount: count,
    regionCount: count,
    maskCount: count,
  }),
  counts: z.strictObject({
    photos: count,
    classified: count,
    classificationFailed: count,
    privacy: z.strictObject({ clear: count, masked: count, review: count, failed: count }),
    privacyRegions: count,
    observations: count,
    facts: count,
    rejectedObservations: count,
  }),
  photos: z.array(inventoryPhotoSchema),
  rejected: z.array(
    z.strictObject({
      materialId: z.uuid(),
      reason: z.enum(OBSERVATION_REJECTION_REASONS),
      object: z.string().max(120),
    }),
  ),
});
export type PhotoInventoryContent = z.infer<typeof photoInventoryContentSchema>;
