import { z } from 'zod';

// Closed value sets shared by the database schema (Postgres enums), the API, and the web app.
// Tuples rather than TS enums: the API runs on Node's erasable type stripping.

export const PROJECT_STATUSES = ['draft', 'active', 'archived'] as const;
export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const MATERIAL_KINDS = ['photo', 'voice_memo'] as const;
export const materialKindSchema = z.enum(MATERIAL_KINDS);
export type MaterialKind = z.infer<typeof materialKindSchema>;

export const MATERIAL_STATUSES = ['uploaded', 'processing', 'ready', 'failed'] as const;
export const materialStatusSchema = z.enum(MATERIAL_STATUSES);
export type MaterialStatus = z.infer<typeof materialStatusSchema>;

export const RUN_STATUSES = ['queued', 'running', 'awaiting_gate', 'completed', 'failed'] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

// One scheduled execution scope of a step within a run (`run_steps`, docs/architecture.md §9):
// `queued` (job enqueued, or waiting for its retry), `running`, then `completed` or `failed`.
export const RUN_STEP_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export const runStepStatusSchema = z.enum(RUN_STEP_STATUSES);
export type RunStepStatus = z.infer<typeof runStepStatusSchema>;

// Gate IDs match `gate_after` in service definitions.
export const GATES = ['fact_conflicts', 'claim_audit'] as const;
export const gateSchema = z.enum(GATES);
export type Gate = z.infer<typeof gateSchema>;

export const FACT_STATUSES = ['candidate', 'verified', 'conflicted', 'rejected'] as const;
export const factStatusSchema = z.enum(FACT_STATUSES);
export type FactStatus = z.infer<typeof factStatusSchema>;

/**
 * What kind of statement a fact is. `opinion` marks subjective judgments, sales talk, and
 * predictions ("the nicest street", "it will only go up in value"): they stay in the candidate
 * set for context, and a database check stops them from ever becoming `verified`.
 */
export const FACT_ASSERTIONS = ['stated', 'opinion'] as const;
export const factAssertionSchema = z.enum(FACT_ASSERTIONS);
export type FactAssertion = z.infer<typeof factAssertionSchema>;

/**
 * `gate_decision`: a value the operator entered at a gate (Gate 1 `edit`, P2-10). It cites the
 * decision, not a material, so it is shown as the operator's statement, never as evidence.
 */
export const FACT_SOURCE_KINDS = [
  'form',
  'transcript_turn',
  'photo_region',
  'gate_decision',
] as const;
export const factSourceKindSchema = z.enum(FACT_SOURCE_KINDS);
export type FactSourceKind = z.infer<typeof factSourceKindSchema>;

export const VALIDATOR_RESULTS = ['pass', 'fail'] as const;
export const validatorResultSchema = z.enum(VALIDATOR_RESULTS);
export type ValidatorResult = z.infer<typeof validatorResultSchema>;

export const VERIFIER_VERDICTS = ['supported', 'unsupported', 'flagged'] as const;
export const verifierVerdictSchema = z.enum(VERIFIER_VERDICTS);
export type VerifierVerdict = z.infer<typeof verifierVerdictSchema>;

export const DECISION_TARGET_KINDS = ['fact', 'claim', 'artifact'] as const;
export const decisionTargetKindSchema = z.enum(DECISION_TARGET_KINDS);
export type DecisionTargetKind = z.infer<typeof decisionTargetKindSchema>;

export const DECISION_CHOICES = ['accept', 'edit', 'remove', 'reject'] as const;
export const decisionChoiceSchema = z.enum(DECISION_CHOICES);
export type DecisionChoice = z.infer<typeof decisionChoiceSchema>;

// Run event types are an open, app-validated set (stored as text) so the pipeline can add
// event types without a migration.
export const RUN_EVENT_TYPES = [
  'run_status_changed',
  'step_started',
  'step_completed',
  'step_failed',
  'gate_opened',
  'gate_decided',
  'usage_recorded',
  'transcript_stored',
  'facts_extracted',
  'photos_inventoried',
  'facts_reconciled',
  'copy_generated',
] as const;
export const runEventTypeSchema = z.enum(RUN_EVENT_TYPES);
export type RunEventType = z.infer<typeof runEventTypeSchema>;

export const runEventPayloadSchema = z.record(z.string(), z.json());
export type RunEventPayload = z.infer<typeof runEventPayloadSchema>;

/** Snapshot of the office profile taken when a project is created. */
export const officeProfileSchema = z.object({
  agencyName: z.string().trim().min(1).max(200),
  contactBlock: z.string().max(2000).optional(),
  tone: z.string().max(200).optional(),
});
export type OfficeProfile = z.infer<typeof officeProfileSchema>;

/** Normalized (0..1) rectangle in image coordinates. */
export const imageRegionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
  })
  .refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1, {
    message: 'Region must lie inside the image',
  });
export type ImageRegion = z.infer<typeof imageRegionSchema>;

/** Where a fact came from ("no source, no claim"). */
export const factSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('form'), field: z.string().min(1) }),
  z
    .object({
      kind: z.literal('transcript_turn'),
      transcriptArtifactId: z.uuid(),
      turnIndex: z.int().nonnegative(),
      startMs: z.int().nonnegative(),
      endMs: z.int().nonnegative(),
      /**
       * The exact span of the turn's text that states the fact, so a normalized value (e.g.
       * "twee" stored as 2) can always be checked against what was said.
       */
      quote: z.string().min(1),
    })
    .refine((s) => s.endMs >= s.startMs, { message: 'endMs must not be before startMs' }),
  z.object({
    kind: z.literal('photo_region'),
    materialId: z.uuid(),
    region: imageRegionSchema,
    maskArtifactId: z.uuid().optional(),
  }),
  z.object({
    kind: z.literal('gate_decision'),
    /** Only Gate 1 creates facts; Gate 2 decides claims. */
    gate: z.literal('fact_conflicts'),
    /** The `fact_conflicts` artifact and the conflict the decision resolved. */
    conflictsArtifactId: z.uuid(),
    conflictId: z.string().regex(/^K\d{2,}$/),
  }),
]);
export type FactSource = z.infer<typeof factSourceSchema>;

/** Non-negative USD amount as an exact decimal string (never a float). */
export const usdAmountSchema = z
  .string()
  .regex(/^\d{1,4}(\.\d{1,8})?$/, 'Expected a non-negative decimal with at most 8 fraction digits');

export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

export const jsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof jsonObjectSchema>;
