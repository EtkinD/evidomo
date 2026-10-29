import { z } from 'zod';
import { factSourceKindSchema } from './domain.ts';
import { APPROVED_SEGMENT_ORIGINS, CLAIM_EDIT_MAX_LENGTH } from './gate2.ts';
import { publicationChecklistResultSchema } from './publication-checklist.ts';
import { STAGED_IMAGE_LABEL, stagingOperationIdSchema } from './staging.ts';
import { photoSubjectSchema } from './vision.ts';

// The export (docs/architecture.md §5 step 9, "Export (P3-09)"): the approved pack rendered as a
// print-ready HTML file, structured portal fields as JSON, and the publishable images (originals
// with faces and plates blurred, approved staged images with a burned-in disclosure). Shared
// because the web app (P4-08) and the headless CLI (P3-10) read the stored files and manifest.
// Copy and fact values describe the property: the files have the run's personal-data scope.

/** The step's manifest: every exported file with its SHA-256. One per export step. */
export const EXPORT_MANIFEST_ARTIFACT_KIND = 'export';
/** The self-contained HTML pack (images embedded as data URIs). */
export const EXPORT_HTML_ARTIFACT_KIND = 'export_html';
/** The portal-fields JSON (`portalFieldsSchema`). */
export const EXPORT_PORTAL_FIELDS_ARTIFACT_KIND = 'export_portal_fields';
/** One publishable JPEG (blurred original or labeled staged image). */
export const EXPORT_IMAGE_ARTIFACT_KIND = 'export_image';

/** Bumped when the layout of the exported files changes. */
export const EXPORT_FORMAT_VERSION = 1;

export const EXPORT_HTML_FILE_NAME = 'listing-pack.html';
export const EXPORT_PORTAL_FIELDS_FILE_NAME = 'portal-fields.json';

/**
 * Why a photo, or the staged version of one, is not exported. Fail-closed: a photo is published
 * only when every privacy region it may contain was found and blurred.
 * - `privacy_review` / `privacy_failed`: the inventory's privacy check is incomplete (a phrase
 *   Spark saw that SAM did not segment, or a failed segmentation);
 * - `privacy_regions_invalid`: a stored region or mask cannot be read or does not fit the photo;
 * - `blur_failed`: blurring or re-encoding failed;
 * - `original_withheld`: a staged image whose original is withheld is withheld with it;
 * - `staged_unverified`: the integrity record does not confirm the published staged image (not
 *   its final image, not checked for people, a person found, or a non-`clear` original);
 * - `label_failed`: the visible disclosure could not be burned into the staged image.
 */
export const EXPORT_WITHHELD_REASONS = [
  'privacy_review',
  'privacy_failed',
  'privacy_regions_invalid',
  'blur_failed',
  'original_withheld',
  'staged_unverified',
  'label_failed',
] as const;
export const exportWithheldReasonSchema = z.enum(EXPORT_WITHHELD_REASONS);
export type ExportWithheldReason = z.infer<typeof exportWithheldReasonSchema>;

const count = z.int().nonnegative();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const pixels = z.int().positive();
/** `photo-01.jpg`, `photo-01-staged.jpg`: numbered by the photo's place in the export. */
const imageFileNameSchema = z.string().regex(/^photo-\d{2,3}(?:-staged)?\.jpg$/);

// --- Facts ------------------------------------------------------------------------------------

/**
 * - `verified`: exactly one verified value on the profile measure (the checklist's
 *   `fact_present` rule; photo facts never count);
 * - `missing`: no such value;
 * - `ambiguous`: several different values; none is published.
 */
export const PORTAL_FIELD_STATUSES = ['verified', 'missing', 'ambiguous'] as const;
export const portalFieldStatusSchema = z.enum(PORTAL_FIELD_STATUSES);
export type PortalFieldStatus = z.infer<typeof portalFieldStatusSchema>;

const fieldCommon = {
  /** The market profile's fact key. */
  key: z.string().min(1).max(64),
  /** The market profile's label. */
  label: z.string().min(1).max(200),
  required: z.boolean(),
  status: portalFieldStatusSchema,
  /** Source kinds of the facts carrying the value, in `FACT_SOURCE_KINDS` order. */
  sources: z.array(factSourceKindSchema),
  /** The verified facts on the profile measure (several for `ambiguous`, none for `missing`). */
  factIds: z.array(z.uuid()),
};

const portalProfileFieldUnionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...fieldCommon,
    type: z.literal('enum'),
    value: z.string().min(1).nullable(),
    unit: z.null(),
    basis: z.null(),
  }),
  z.strictObject({
    ...fieldCommon,
    type: z.literal('area'),
    value: z.number().nonnegative().nullable(),
    unit: z.string().min(1),
    /** The profile's measurement basis for this area, with its label. */
    basis: z.strictObject({ id: z.string().min(1), label: z.string().min(1) }),
  }),
  z.strictObject({
    ...fieldCommon,
    type: z.literal('volume'),
    value: z.number().nonnegative().nullable(),
    unit: z.string().min(1).nullable(),
    basis: z.null(),
  }),
  z.strictObject({
    ...fieldCommon,
    type: z.literal('integer'),
    value: z.int().nullable(),
    unit: z.null(),
    basis: z.null(),
  }),
  z.strictObject({
    ...fieldCommon,
    type: z.literal('money'),
    value: z.number().nonnegative().nullable(),
    /** The profile's currency (ISO 4217). */
    unit: z.string().min(1).nullable(),
    basis: z.null(),
  }),
  z.strictObject({
    ...fieldCommon,
    type: z.literal('boolean'),
    value: z.boolean().nullable(),
    unit: z.null(),
    basis: z.null(),
  }),
]);

/** One market-profile fact as a typed portal field; every profile fact appears, in order. */
export const portalProfileFieldSchema = portalProfileFieldUnionSchema.superRefine((field, ctx) => {
  const consistent =
    field.status === 'verified'
      ? field.value !== null && field.factIds.length > 0
      : field.value === null &&
        (field.status === 'missing' ? field.factIds.length === 0 : field.factIds.length > 1);
  if (!consistent) {
    ctx.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'Only a verified field has a value; missing has no facts, ambiguous several',
    });
  }
});
export type PortalProfileField = z.infer<typeof portalProfileFieldSchema>;

/** A verified fact outside the profile (`other:` keys), e.g. a station's cycling time. */
export const portalOtherFactSchema = z.strictObject({
  key: z.string().regex(/^other:[a-z][a-z0-9_]*$/),
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().min(1).nullable(),
  basis: z.string().min(1).nullable(),
  sources: z.array(factSourceKindSchema).min(1),
  factIds: z.array(z.uuid()).min(1),
});
export type PortalOtherFact = z.infer<typeof portalOtherFactSchema>;

/**
 * Something the photos show. Presence only: a photo fact's stored value is an instance count in
 * one photo, never a property total, so no number is published.
 */
export const portalPresenceSchema = z.strictObject({
  key: z.string().regex(/^other:[a-z][a-z0-9_]*$/),
  /** Rooms of the photos it was seen in (closed subject set). */
  seenIn: z.array(photoSubjectSchema),
  factIds: z.array(z.uuid()).min(1),
});
export type PortalPresence = z.infer<typeof portalPresenceSchema>;

// --- Copy -------------------------------------------------------------------------------------

export const portalCopySegmentSchema = z.strictObject({
  claimId: z.uuid(),
  index: count,
  paragraph: count,
  text: z.string().min(1).max(CLAIM_EDIT_MAX_LENGTH),
  factIds: z.array(z.string().min(1)).min(1),
  origin: z.enum(APPROVED_SEGMENT_ORIGINS),
});
export type PortalCopySegment = z.infer<typeof portalCopySegmentSchema>;

/**
 * One copy variant: `text` joins the segments with a space, paragraphs with a blank line. Empty
 * when every segment was removed at Gate 2.
 */
export const portalCopyVariantSchema = z.strictObject({
  text: z.string(),
  segments: z.array(portalCopySegmentSchema),
});
export type PortalCopyVariant = z.infer<typeof portalCopyVariantSchema>;

// --- Images -----------------------------------------------------------------------------------

const imageCommon = {
  /** 1-based place in the upload order; the first image is the cover. */
  position: z.int().positive(),
  fileName: imageFileNameSchema,
  /** The `export_image` artifact holding the file. */
  fileArtifactId: z.uuid(),
  /** The original photo (`materials.id`), also for a staged image. */
  materialId: z.uuid(),
  width: pixels,
  height: pixels,
  sizeBytes: pixels,
  sha256,
};

export const portalImageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...imageCommon,
    kind: z.literal('original'),
    /** The inventory's cover rank; null when the photo was not classified. */
    coverRank: z.int().positive().nullable(),
    subject: photoSubjectSchema.nullable(),
    /** `clear`: nothing to blur (the stored bytes); `masked`: every privacy region blurred. */
    privacy: z.strictObject({
      status: z.enum(['clear', 'masked']),
      blurredRegions: count,
    }),
    /** The approved staged version shown in its place, if any. */
    stagedFileName: imageFileNameSchema.nullable(),
  }),
  z.strictObject({
    ...imageCommon,
    kind: z.literal('staged'),
    /** The `staged_image` artifact Gate 2 approved (`publishedArtifactId`). */
    stagedArtifactId: z.uuid(),
    operationId: stagingOperationIdSchema,
    /** Shown with the image in the HTML and burned into its pixels; XMP marker kept. */
    disclosure: z.strictObject({
      label: z.literal(STAGED_IMAGE_LABEL),
      burnedIn: z.literal(true),
      digitalSourceType: z.url(),
    }),
    /** The original, exported next to it. */
    originalFileName: imageFileNameSchema,
  }),
]);
export type PortalImage = z.infer<typeof portalImageSchema>;

export const portalWithheldImageSchema = z.strictObject({
  materialId: z.uuid(),
  /** 1-based upload order, so the operator can find the photo. */
  uploadPosition: z.int().positive(),
  kind: z.enum(['original', 'staged']),
  /** The staged image withheld; null for an original. */
  stagedArtifactId: z.uuid().nullable(),
  reason: exportWithheldReasonSchema,
});
export type PortalWithheldImage = z.infer<typeof portalWithheldImageSchema>;

// --- Portal fields ----------------------------------------------------------------------------

/**
 * `portal-fields.json`: what a listing portal form or feed needs, built deterministically from
 * the stored artifacts. Serialized with this schema's key order and 2-space indentation.
 */
export const portalFieldsSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    formatVersion: z.literal(EXPORT_FORMAT_VERSION),
    runId: z.uuid(),
    approvedPackArtifactId: z.uuid(),
    /** The Gate 2 sign-off time; the export uses no clock of its own. */
    approvedAt: z.iso.datetime({ offset: true }),
    market: z.strictObject({ id: z.string().min(1), version: z.int().positive() }),
    outputLanguage: z.string().regex(/^[a-z]{2}$/),
    facts: z.strictObject({
      profile: z.array(portalProfileFieldSchema),
      other: z.array(portalOtherFactSchema),
      presences: z.array(portalPresenceSchema),
    }),
    copy: z.strictObject({ portal: portalCopyVariantSchema, social: portalCopyVariantSchema }),
    /** Publishable images in order; a staged image directly precedes its original. */
    images: z.array(portalImageSchema),
    withheld: z.array(portalWithheldImageSchema),
    /** The P3-07 result, unchanged. */
    publicationChecklist: publicationChecklistResultSchema,
  })
  .superRefine((fields, ctx) => {
    fields.images.forEach((image, i) => {
      if (image.position !== i + 1) {
        ctx.addIssue({ code: 'custom', path: ['images', i, 'position'], message: 'Positions' });
      }
    });
    const names = fields.images.map((image) => image.fileName);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['images'], message: 'File names must be unique' });
    }
    const checklistMarket = fields.publicationChecklist.market;
    if (
      checklistMarket.id !== fields.market.id ||
      checklistMarket.version !== fields.market.version
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['publicationChecklist', 'market'],
        message: 'The checklist must be the run market’s',
      });
    }
  });
export type PortalFields = z.infer<typeof portalFieldsSchema>;

// --- Stored artifacts -------------------------------------------------------------------------

export const EXPORT_FILE_ROLES = ['html', 'portal_fields', 'image'] as const;
export const exportFileRoleSchema = z.enum(EXPORT_FILE_ROLES);
export type ExportFileRole = z.infer<typeof exportFileRoleSchema>;

const exportFileSchema = z.strictObject({
  artifactId: z.uuid(),
  role: exportFileRoleSchema,
  fileName: z.union([
    z.literal(EXPORT_HTML_FILE_NAME),
    z.literal(EXPORT_PORTAL_FIELDS_FILE_NAME),
    imageFileNameSchema,
  ]),
  mimeType: z.enum(['text/html', 'application/json', 'image/jpeg']),
  sizeBytes: pixels,
  sha256,
});
export type ExportFile = z.infer<typeof exportFileSchema>;

/** Content of each exported file's artifact (the file itself is the artifact's file). */
export const exportFileContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  role: exportFileRoleSchema,
  fileName: exportFileSchema.shape.fileName,
  sizeBytes: pixels,
  sha256,
});
export type ExportFileContent = z.infer<typeof exportFileContentSchema>;

/**
 * Content of the `export` manifest artifact: the HTML, the JSON, then the images in export
 * order, with their SHA-256. IDs, names, hashes, and counts only.
 */
export const exportManifestContentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    formatVersion: z.literal(EXPORT_FORMAT_VERSION),
    approvedPackArtifactId: z.uuid(),
    inventoryArtifactId: z.uuid(),
    readyToPublish: z.boolean(),
    files: z.array(exportFileSchema).min(2),
    counts: z.strictObject({
      images: count,
      originals: count,
      staged: count,
      /** Originals with at least one blurred region. */
      blurredImages: count,
      blurredRegions: count,
      /** Withheld originals and staged images. */
      withheld: count,
    }),
  })
  .superRefine((manifest, ctx) => {
    const [html, json, ...images] = manifest.files;
    if (
      html?.role !== 'html' ||
      json?.role !== 'portal_fields' ||
      images.some((f) => f.role !== 'image') ||
      images.length !== manifest.counts.images
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'The HTML, the JSON, then one entry per image',
      });
    }
    if (manifest.counts.originals + manifest.counts.staged !== manifest.counts.images) {
      ctx.addIssue({ code: 'custom', path: ['counts'], message: 'Image counts must add up' });
    }
  });
export type ExportManifestContent = z.infer<typeof exportManifestContentSchema>;
