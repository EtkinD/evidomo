import { z } from 'zod';
import {
  areaUnitSchema,
  definitionIdSchema,
  definitionVersionSchema,
  languageCodeSchema,
  volumeUnitSchema,
} from './definitions.ts';
import {
  gateSchema,
  materialKindSchema,
  materialStatusSchema,
  officeProfileSchema,
  projectStatusSchema,
  runStatusSchema,
} from './domain.ts';
import { materialFailureReasonSchema } from './materials.ts';

// Project and input API contracts (docs/architecture.md §8 "Project and input API"): the market
// and service views the web generates its forms from, projects, the fact form, material uploads,
// readiness, and starting a run. Fact form values and titles describe the property
// (personal-data scope); they are returned to the project's owner only.

const timestamp = z.iso.datetime({ offset: true });
const count = z.int().nonnegative();

// ---------------------------------------------------------------------------------------------
// Definitions, as the web needs them (internal fields such as transcription keywords, evidence
// objects, and the publication checklist are never sent)
// ---------------------------------------------------------------------------------------------

export const definitionRefSchema = z.strictObject({
  id: definitionIdSchema,
  version: definitionVersionSchema,
});
export type DefinitionRef = z.infer<typeof definitionRefSchema>;

/** `GET /api/markets/:id/:version` and `GET /api/services/:id/:version` path parameters. */
export const definitionParamsSchema = z.strictObject({
  id: definitionIdSchema,
  version: z
    .string()
    .regex(/^[1-9]\d{0,8}$/, 'Expected a positive integer version')
    .transform(Number),
});

export const marketSummarySchema = z.strictObject({
  id: definitionIdSchema,
  version: definitionVersionSchema,
  name: z.string(),
  outputLanguages: z.array(languageCodeSchema).min(1),
  defaultOutputLanguage: languageCodeSchema,
});
export type MarketSummary = z.infer<typeof marketSummarySchema>;

/** `GET /api/markets`: every market profile the server loaded, in registry order. */
export const marketListResponseSchema = z.strictObject({ markets: z.array(marketSummarySchema) });
export type MarketListResponse = z.infer<typeof marketListResponseSchema>;

const areaBasisViewSchema = z.strictObject({ id: z.string(), label: z.string() });

const fieldCommon = { key: z.string(), label: z.string(), required: z.boolean() };

/**
 * One fact form field, generated from a market fact. Validation rules (enforced by the server on
 * save, in the same way as the run's fact extraction step):
 *
 * - `enum`: one of `values`, exactly.
 * - `area`, `volume`, `money`: a finite JSON number >= 0, in `unit` / `currency`.
 * - `integer`: a safe integer within `min`..`max` (null = unbounded).
 * - `boolean`: `true` or `false`.
 */
export const factFormFieldSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...fieldCommon, type: z.literal('enum'), values: z.array(z.string()).min(2) }),
  z.strictObject({
    ...fieldCommon,
    type: z.literal('area'),
    unit: areaUnitSchema,
    basis: areaBasisViewSchema,
  }),
  z.strictObject({ ...fieldCommon, type: z.literal('volume'), unit: volumeUnitSchema }),
  z.strictObject({
    ...fieldCommon,
    type: z.literal('integer'),
    min: z.int().nullable(),
    max: z.int().nullable(),
  }),
  z.strictObject({ ...fieldCommon, type: z.literal('money'), currency: z.string() }),
  z.strictObject({ ...fieldCommon, type: z.literal('boolean') }),
]);
export type FactFormField = z.infer<typeof factFormFieldSchema>;

export const marketFormSchema = z.strictObject({
  ...marketSummarySchema.shape,
  currency: z.string().nullable(),
  units: z.strictObject({ area: areaUnitSchema, volume: volumeUnitSchema.nullable() }),
  areaBases: z.array(areaBasisViewSchema),
  /** In profile order, which is also the order the fact sheet uses. */
  facts: z.array(factFormFieldSchema).min(1),
});
export type MarketForm = z.infer<typeof marketFormSchema>;

/** `GET /api/markets/:id/:version`. */
export const marketFormResponseSchema = z.strictObject({ market: marketFormSchema });
export type MarketFormResponse = z.infer<typeof marketFormResponseSchema>;

export const serviceInputViewSchema = z.discriminatedUnion('type', [
  z.strictObject({
    key: z.string(),
    type: z.literal('images'),
    min: count,
    max: count,
    required: z.boolean(),
  }),
  z.strictObject({
    key: z.string(),
    type: z.literal('audio'),
    maxSeconds: z.int().positive(),
    required: z.boolean(),
  }),
  z.strictObject({ key: z.string(), type: z.literal('form'), required: z.boolean() }),
]);
export type ServiceInputView = z.infer<typeof serviceInputViewSchema>;

/** `GET /api/services/:id/:version`: what the capture screen needs (steps are not sent). */
export const serviceResponseSchema = z.strictObject({
  service: z.strictObject({
    id: definitionIdSchema,
    version: definitionVersionSchema,
    name: z.string(),
    inputs: z.array(serviceInputViewSchema),
  }),
});
export type ServiceResponse = z.infer<typeof serviceResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Fact form
// ---------------------------------------------------------------------------------------------

/**
 * Fields outside the market profile ("extra fields", e.g. `street_name`, `place_name`) are
 * stored too: their key must be a snake_case slug and their value a number, a boolean, or short
 * text. The run turns them into `other:<key>` facts. The pattern and the text limit match the
 * fact extraction step's (`OTHER_SLUG_PATTERN`, a test pins both).
 */
export const FACT_FORM_LIMITS = {
  extraKeyPattern: /^[a-z][a-z0-9_]{0,63}$/,
  extraTextMaxLength: 300,
  maxExtraFields: 20,
} as const;

export const factFormValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type FactFormValue = z.infer<typeof factFormValueSchema>;

/** Stored values: `null` and absent both mean unknown, so nulls are never stored. */
export const factFormValuesSchema = z.record(z.string(), factFormValueSchema);
export type FactFormValues = z.infer<typeof factFormValuesSchema>;

/**
 * `PUT /api/projects/:projectId/fact-form`: the whole form (keys not sent are cleared). A draft
 * may leave required fields empty; each value that is present must be valid.
 */
export const putFactFormRequestSchema = z.strictObject({
  values: z
    .record(z.string().min(1).max(100), factFormValueSchema.nullable())
    .refine((values) => Object.keys(values).length <= 100, 'At most 100 fields'),
});
export type PutFactFormRequest = z.input<typeof putFactFormRequestSchema>;

/** Why one fact form value was refused (`fields` of a `validation_failed` error). */
export const FACT_FORM_FIELD_PROBLEMS = [
  /** Wrong JSON type for the field (e.g. text for an area, a number for an enum). */
  'wrong_type',
  /** An `integer` field got a fractional or unsafe number. */
  'not_an_integer',
  /** Below 0 (area, volume, money) or outside `min`..`max` (integer). */
  'out_of_range',
  /** Not one of the enum's `values`. */
  'not_allowed',
  /** An extra field's key is not a snake_case slug. */
  'invalid_key',
  /** An extra field's text is empty or longer than `extraTextMaxLength`. */
  'invalid_text',
  /** More than `maxExtraFields` extra fields; the keys past the limit (in key order) get it. */
  'too_many_fields',
] as const;
export const factFormFieldProblemSchema = z.enum(FACT_FORM_FIELD_PROBLEMS);
export type FactFormFieldProblem = z.infer<typeof factFormFieldProblemSchema>;

// ---------------------------------------------------------------------------------------------
// Materials and uploads
// ---------------------------------------------------------------------------------------------

/**
 * `Content-Type` values the upload routes accept. The type is a CSRF guard (none of them can be
 * sent cross-site without a CORS preflight), never validation: the server identifies the file
 * by its content. HEIC types are accepted so the server can answer `heic_not_supported`.
 */
export const PHOTO_UPLOAD_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

/** `MediaRecorder` output (WebM/Opus, Ogg/Opus, Safari's MP4/AAC) and common recorder files. */
export const VOICE_MEMO_UPLOAD_CONTENT_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/flac',
  'audio/x-flac',
  'audio/amr',
  'audio/3gpp',
] as const;

export const projectParamsSchema = z.strictObject({ projectId: z.uuid() });
export const materialParamsSchema = z.strictObject({
  projectId: z.uuid(),
  materialId: z.uuid(),
});

export const projectMaterialSchema = z.strictObject({
  id: z.uuid(),
  kind: materialKindSchema,
  status: materialStatusSchema,
  /**
   * 1-based position within its kind, in upload order (the order the run uses for photos).
   * Upload order is the order in which the server committed the uploads, so the web uploads
   * photos one at a time to keep the capture order.
   */
  position: z.int().positive(),
  /** Of the stored (processed) file: `image/jpeg` for photos, `audio/wav` for voice memos. */
  mimeType: z.string(),
  sizeBytes: z.int().positive(),
  /** Stored photo dimensions; null for voice memos and unprocessed rows. */
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  /** Measured voice memo duration; null for photos and unprocessed rows. */
  durationMs: z.int().positive().nullable(),
  /** Set on `failed` rows only. Uploads are processed before a row exists, so this is rare. */
  failureReason: materialFailureReasonSchema.nullable(),
  createdAt: timestamp,
});
export type ProjectMaterial = z.infer<typeof projectMaterialSchema>;

/** `POST …/materials/photos` (201) and `PUT …/materials/voice-memo` (200). */
export const uploadMaterialResponseSchema = z.strictObject({ material: projectMaterialSchema });
export type UploadMaterialResponse = z.infer<typeof uploadMaterialResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Readiness and runs
// ---------------------------------------------------------------------------------------------

/** One thing still missing before a run can start (`missing` of readiness and `not_ready`). */
export const readinessItemSchema = z.discriminatedUnion('kind', [
  /** The photo count is outside the service's `min`..`max`. */
  z.strictObject({ kind: z.literal('photos'), count, min: count, max: count }),
  /** The service requires a voice walkthrough and none is uploaded. */
  z.strictObject({ kind: z.literal('voice_memo') }),
  /** A required fact is empty (`missing`), or a stored value no longer fits (`invalid`). */
  z.strictObject({
    kind: z.literal('fact'),
    key: z.string(),
    problem: z.enum(['missing', 'invalid']),
  }),
]);
export type ReadinessItem = z.infer<typeof readinessItemSchema>;

export const projectRunSummarySchema = z.strictObject({
  id: z.uuid(),
  status: runStatusSchema,
  gate: gateSchema.nullable(),
  createdAt: timestamp,
});
export type ProjectRunSummary = z.infer<typeof projectRunSummarySchema>;

export const projectReadinessSchema = z.strictObject({
  /** Inputs complete and no active run. The daily budget is checked only when starting. */
  canStartRun: z.boolean(),
  /**
   * A run that is queued, running, awaiting a gate, or completed exists: uploads, deletions, and
   * fact form and office profile changes are refused. When every run has failed, inputs are
   * editable again (a new run is started on the corrected inputs).
   */
  inputsLocked: z.boolean(),
  /** A run that is `queued`, `running`, or `awaiting_gate`; null otherwise. */
  activeRunId: z.uuid().nullable(),
  missing: z.array(readinessItemSchema),
  photos: z.strictObject({ count, min: count, max: count, required: z.boolean() }),
  voiceMemo: z.strictObject({
    present: z.boolean(),
    required: z.boolean(),
    maxSeconds: z.int().positive(),
  }),
});
export type ProjectReadiness = z.infer<typeof projectReadinessSchema>;

/** Longest access code the API compares (both sides are hashed, so length leaks nothing). */
export const ACCESS_CODE_MAX_LENGTH = 256;

/**
 * `POST /api/projects/:projectId/runs` (empty body or no body when no access code is configured).
 * `accessCode` is required when the server has `LIVE_RUN_ACCESS_CODE` set (the public
 * deployment): a missing or wrong code answers 403 `access_code_invalid`. Surrounding whitespace
 * is trimmed (pasted codes); the comparison is otherwise exact.
 */
export const startRunRequestSchema = z.strictObject({
  accessCode: z.string().trim().min(1).max(ACCESS_CODE_MAX_LENGTH).optional(),
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

/** 201 from `POST /api/projects/:projectId/runs`. */
export const startRunResponseSchema = z.strictObject({ run: projectRunSummarySchema });
export type StartRunResponse = z.infer<typeof startRunResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

const titleSchema = z.string().trim().min(1).max(200);
const officeProfileRequestSchema = z.strictObject(officeProfileSchema.shape);

/** `POST /api/projects`. The service is pinned by the server (listing-launch v1). */
export const createProjectRequestSchema = z.strictObject({
  title: titleSchema,
  officeProfile: officeProfileRequestSchema,
  market: definitionRefSchema,
  /** Must be one of the market's `outputLanguages`. */
  outputLanguage: languageCodeSchema,
});
export type CreateProjectRequest = z.input<typeof createProjectRequestSchema>;

/** `PATCH /api/projects/:projectId`: at least one field; the office profile is replaced whole. */
export const updateProjectRequestSchema = z
  .strictObject({
    title: titleSchema.optional(),
    officeProfile: officeProfileRequestSchema.optional(),
  })
  .refine((body) => body.title !== undefined || body.officeProfile !== undefined, {
    message: 'Provide title or officeProfile',
  });
export type UpdateProjectRequest = z.input<typeof updateProjectRequestSchema>;

export const projectSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  status: projectStatusSchema,
  officeProfile: officeProfileSchema,
  /**
   * `name` is null when the server no longer has this market version (in the project list only;
   * the project detail needs the definition and answers 500 then).
   */
  market: z.strictObject({ ...definitionRefSchema.shape, name: z.string().nullable() }),
  outputLanguage: languageCodeSchema,
  service: definitionRefSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Project = z.infer<typeof projectSchema>;

export const projectSummarySchema = z.strictObject({
  ...projectSchema.shape,
  photoCount: count,
  hasVoiceMemo: z.boolean(),
  latestRun: projectRunSummarySchema.nullable(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

/** `GET /api/projects`: the user's projects, newest first. */
export const projectListResponseSchema = z.strictObject({
  projects: z.array(projectSummarySchema),
});
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

/**
 * `GET /api/projects/:projectId`, and the body of every project mutation (create, update, fact
 * form) so the web can replace its cached copy.
 */
export const projectDetailResponseSchema = z.strictObject({
  project: projectSchema,
  factForm: z.strictObject({ values: factFormValuesSchema }),
  /** Photos in position order, then the voice memo. */
  materials: z.array(projectMaterialSchema),
  readiness: projectReadinessSchema,
  latestRun: projectRunSummarySchema.nullable(),
});
export type ProjectDetailResponse = z.infer<typeof projectDetailResponseSchema>;
