import { z } from 'zod';

// Virtual staging (docs/architecture.md §5, staging step): declared-operation edits of selected
// photos. Shared because the integrity check (P3-05), Gate 2 (P3-08), the publication checklist
// (P3-07), the export (P3-09), and the web app read the stored records.

/** One file artifact per staged image: the JPEG plus `stagedImageContentSchema`. */
export const STAGED_IMAGE_ARTIFACT_KIND = 'staged_image';
/** One per staging step: what happened to every inventoried photo. */
export const STAGED_IMAGES_ARTIFACT_KIND = 'staged_images';

/**
 * The visible label every staged image must carry wherever it is shown or exported (market
 * checklist rule `staged_images_labeled`). Localizing it is the export's decision.
 */
export const STAGED_IMAGE_LABEL = 'Virtually staged';

/**
 * Kinds of declared operation allowed by the P1-07 decision: furniture added or replaced, or
 * clutter and loose objects removed. Fixed elements (windows, doors, radiators) stay intact.
 */
export const STAGING_OPERATION_KINDS = ['furnish', 'declutter'] as const;
export const stagingOperationKindSchema = z.enum(STAGING_OPERATION_KINDS);
export type StagingOperationKind = z.infer<typeof stagingOperationKindSchema>;

/** The operation catalog's IDs; the texts live with the prompt in the api (versioned). */
export const STAGING_OPERATION_IDS = [
  'furnish_living_room',
  'furnish_dining_room',
  'furnish_bedroom',
  'furnish_study',
  'declutter',
] as const;
export const stagingOperationIdSchema = z.enum(STAGING_OPERATION_IDS);
export type StagingOperationId = z.infer<typeof stagingOperationIdSchema>;

/** A declared operation exactly as sent: catalog text, never model-written text. */
export const stagingOperationSchema = z.strictObject({
  id: stagingOperationIdSchema,
  kind: stagingOperationKindSchema,
  text: z.string().min(1).max(500),
});
export type StagingOperation = z.infer<typeof stagingOperationSchema>;

/**
 * Why an inventoried photo was not staged (no model call):
 * - `classification_failed`: no subject or quality to decide on;
 * - `privacy_review` / `privacy_failed`: never sent to the image model;
 * - `privacy_masked`: people or plates were found; the original's masks do not fit a re-rendered
 *   image, so it is not staged (v1);
 * - `poor_quality`: staging would not rescue the photo;
 * - `not_stageable`: no declared operation fits its subject (exteriors, plans, hallways, ...);
 * - `operation_not_enabled`: the fitting operation's kind is not in the step's `operation_kinds`
 *   (v1 enables `furnish` only, so cluttered rooms are not staged at all);
 * - `subject_already_furnished`: a better-ranked photo of the same subject is furnished already
 *   (two independently furnished views of one room would contradict each other);
 * - `cap_reached`: eligible, but `max_staged_images` was reached.
 */
export const STAGING_SKIP_REASONS = [
  'classification_failed',
  'privacy_review',
  'privacy_failed',
  'privacy_masked',
  'poor_quality',
  'not_stageable',
  'operation_not_enabled',
  'subject_already_furnished',
  'cap_reached',
] as const;
export const stagingSkipReasonSchema = z.enum(STAGING_SKIP_REASONS);
export type StagingSkipReason = z.infer<typeof stagingSkipReasonSchema>;

/**
 * Why an edit that was sent produced no staged image. Errors a step retry could fix (rate
 * limits, 5xx, timeouts) fail the step execution instead.
 * - `rejected_input`: the API refused the request (400/413/415/422);
 * - `no_image`: a 2xx response without an image (failed or safety-filtered, not billed);
 * - `invalid_output`: the returned bytes are not a decodable image.
 */
export const STAGING_FAILURE_REASONS = ['rejected_input', 'no_image', 'invalid_output'] as const;
export const stagingFailureReasonSchema = z.enum(STAGING_FAILURE_REASONS);
export type StagingFailureReason = z.infer<typeof stagingFailureReasonSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const pixels = z.int().positive();

/**
 * Content of a `staged_image` artifact; the artifact's file is the staged JPEG (re-encoded, no
 * model metadata). Links the staged image to its original and records exactly what was asked.
 */
export const stagedImageContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  promptVersion: z.int().positive(),
  /** The photo as stored (P2-05) and inventoried; the staged image never replaces it. */
  original: z.strictObject({
    materialId: z.uuid(),
    sha256: sha256Schema,
    width: pixels,
    height: pixels,
  }),
  operation: stagingOperationSchema,
  /** The full prompt sent: the operation wrapped in the fixed preservation instructions. */
  prompt: z.string().min(1).max(2000),
  model: z.string().min(1),
  /** `size` sent: the original's `WxH`, which Meta treats as an aspect ratio only. */
  requestedSize: z.string().regex(/^[1-9][0-9]*x[1-9][0-9]*$/),
  /** The edit was sent with image search, web search, and shell disabled (P1-08). */
  toolsDisabled: z.literal(true),
  /** What the model returned, before re-encoding. */
  modelOutput: z.strictObject({
    format: z.enum(['jpeg', 'png', 'webp']),
    width: pixels,
    height: pixels,
  }),
  /** The stored file. */
  stored: z.strictObject({
    mimeType: z.literal('image/jpeg'),
    width: pixels,
    height: pixels,
    sizeBytes: pixels,
    sha256: sha256Schema,
  }),
  /** `|aspect(stored) / aspect(original) − 1|`; the integrity check fails above 3%. */
  aspectRatioChange: z.number().nonnegative(),
  /** Must be shown with the image wherever it is published (`staged_images_labeled`). */
  disclosure: z.strictObject({
    label: z.literal(STAGED_IMAGE_LABEL),
    visibleLabelRequired: z.literal(true),
  }),
});
export type StagedImageContent = z.infer<typeof stagedImageContentSchema>;

const count = z.int().nonnegative();

const stagingPhotoOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('staged'),
    materialId: z.uuid(),
    operationId: stagingOperationIdSchema,
    /** The `staged_image` artifact (file + record). */
    stagedArtifactId: z.uuid(),
  }),
  z.strictObject({
    status: z.literal('failed'),
    materialId: z.uuid(),
    operationId: stagingOperationIdSchema,
    reason: stagingFailureReasonSchema,
  }),
  z.strictObject({
    status: z.literal('skipped'),
    materialId: z.uuid(),
    /** The operation it would have had (`cap_reached`, `subject_already_furnished`), else null. */
    operationId: stagingOperationIdSchema.nullable(),
    reason: stagingSkipReasonSchema,
  }),
]);
export type StagingPhotoOutcome = z.infer<typeof stagingPhotoOutcomeSchema>;

/**
 * Content of the `staged_images` artifact (one per staging step): one outcome per photo of the
 * run's `photo_inventory`, in inventory order. IDs and closed-set codes only.
 */
export const stagedImagesContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  promptVersion: z.int().positive(),
  model: z.string().min(1),
  maxStagedImages: count,
  /** The operation kinds the step allowed (`operation_kinds`). */
  operationKinds: z.array(stagingOperationKindSchema).min(1),
  /** The `photo_inventory` artifact the selection read. */
  inventoryArtifactId: z.uuid(),
  counts: z.strictObject({
    photos: count,
    /** Photos with a fitting operation that passed the privacy and quality rules. */
    eligible: count,
    /** Edits sent (at most `maxStagedImages`). */
    requested: count,
    staged: count,
    failed: count,
    skipped: count,
  }),
  photos: z.array(stagingPhotoOutcomeSchema),
});
export type StagedImagesContent = z.infer<typeof stagedImagesContentSchema>;
