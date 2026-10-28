import { z } from 'zod';
import { factSourceKindSchema, factStatusSchema } from './domain.ts';

// Reconciliation (docs/architecture.md §5 step 4): the Verified Fact Sheet and the conflict list
// that Gate 1 resolves. Shared because the Gate 1 API (P2-10) lists and resolves the conflicts
// and the web app shows them with their evidence (P4-06). Values, keys, and explanations
// describe the property, so both artifacts have the run's personal-data scope (they cascade
// with the project) and never go into events or logs.

export const VERIFIED_FACT_SHEET_ARTIFACT_KIND = 'verified_fact_sheet';
export const FACT_CONFLICTS_ARTIFACT_KIND = 'fact_conflicts';

/** A stored fact value as reconciliation compares it: exact scalars only. */
export const reconciledValueSchema = z.union([z.number(), z.string(), z.boolean()]);
export type ReconciledValue = z.infer<typeof reconciledValueSchema>;

/** Who decided a fact's outcome: the deterministic rules or a validated model judgment. */
export const RECONCILIATION_DECIDERS = ['code', 'model'] as const;
export type ReconciliationDecider = (typeof RECONCILIATION_DECIDERS)[number];

/**
 * Why a fact got its status.
 *
 * - verified: `agreement` (two or more sources, same value on the same measure), `single_source`
 *   (one stated source that nothing contradicts: a form field, a photo observation, or a market
 *   fact stated once), `corroborating` (stated without a basis and equal to the verified value),
 *   `model_verified` (a model grouping that passed the code checks).
 * - conflicted: `value_mismatch` (same quantity, same unit and basis, different values),
 *   `model_conflict` (a contradiction the model found and code accepted).
 * - rejected: `opinion` (marked at extraction, or judged subjective by the model),
 *   `different_basis` / `different_unit` (a different measure than the fact's, so neither
 *   support nor contradiction), `out_of_scope` / `ambiguous` (model), `not_reconciled` (a
 *   transcript candidate the model did not account for validly; never verified by default).
 */
export const FACT_OUTCOME_REASONS = [
  'agreement',
  'single_source',
  'corroborating',
  'model_verified',
  'value_mismatch',
  'model_conflict',
  'opinion',
  'different_basis',
  'different_unit',
  'out_of_scope',
  'ambiguous',
  'not_reconciled',
] as const;
export const factOutcomeReasonSchema = z.enum(FACT_OUTCOME_REASONS);
export type FactOutcomeReason = z.infer<typeof factOutcomeReasonSchema>;

export const CONFLICT_KINDS = [
  'value_mismatch',
  'count_mismatch',
  'presence_mismatch',
  'other',
] as const;
export const conflictKindSchema = z.enum(CONFLICT_KINDS);
export type ConflictKind = z.infer<typeof conflictKindSchema>;

const count = z.int().nonnegative();
const key = z.string().min(1).max(80);
const text = (max: number) => z.string().min(1).max(max);
/** Catalog IDs the model saw: `F.<field>`, `Cnn`, `Pnn.Rk`. */
const evidenceId = z.string().regex(/^(F\.[a-z][a-z0-9_]*|C\d{2,3}|P\d{2,3}\.R\d+)$/);

const measure = {
  key,
  value: reconciledValueSchema,
  unit: z.string().min(1).nullable(),
  basis: z.string().min(1).nullable(),
};

/** One line of the Verified Fact Sheet: a value and every fact that supports it. */
export const factSheetEntrySchema = z.strictObject({
  /** `V01`, `V02`, ... in key order; stable within the artifact. */
  id: z.string().regex(/^V\d{2,}$/),
  ...measure,
  /** The supporting facts; the value equals the value of at least one of them exactly. */
  factIds: z.array(z.uuid()).min(1),
  evidenceIds: z.array(evidenceId).min(1),
  sourceKinds: z.array(factSourceKindSchema).min(1),
  reason: z.enum(['agreement', 'single_source', 'model_verified']),
  decidedBy: z.enum(RECONCILIATION_DECIDERS),
});
export type FactSheetEntry = z.infer<typeof factSheetEntrySchema>;

/** A fact on a different measure than its key's: neither support nor contradiction. */
export const basisNoteSchema = z.strictObject({
  factId: z.uuid(),
  evidenceId,
  ...measure,
  reason: z.enum(['different_basis', 'different_unit']),
  /** The sheet entry or conflict of the same quantity, when there is one. */
  relatedEntryId: z
    .string()
    .regex(/^V\d{2,}$/)
    .nullable(),
  relatedConflictId: z
    .string()
    .regex(/^K\d{2,}$/)
    .nullable(),
  explanation: text(300),
});
export type BasisNote = z.infer<typeof basisNoteSchema>;

export const factOutcomeSchema = z.strictObject({
  factId: z.uuid(),
  evidenceId,
  status: factStatusSchema.exclude(['candidate']),
  reason: factOutcomeReasonSchema,
  decidedBy: z.enum(RECONCILIATION_DECIDERS),
  entryId: z
    .string()
    .regex(/^V\d{2,}$/)
    .nullable(),
  conflictId: z
    .string()
    .regex(/^K\d{2,}$/)
    .nullable(),
  /** The model's one-sentence reason for a rejection, clipped; null otherwise. */
  note: z.string().max(300).nullable(),
});
export type FactOutcome = z.infer<typeof factOutcomeSchema>;

/** One side of a conflict: the facts that state the same value on the same measure. */
export const conflictSideSchema = z.strictObject({
  ...measure,
  factIds: z.array(z.uuid()).min(1),
  evidenceIds: z.array(evidenceId).min(1),
  sourceKinds: z.array(factSourceKindSchema).min(1),
});
export type ConflictSide = z.infer<typeof conflictSideSchema>;

/**
 * One conflict for Gate 1. Conflicts are disjoint (a fact is in at most one), so a decision per
 * conflicted fact (`decisions.target_kind = 'fact'`) resolves exactly one conflict.
 */
export const factConflictSchema = z.strictObject({
  /** `K01`, `K02`, ... in key order; stable within the artifact. */
  id: z.string().regex(/^K\d{2,}$/),
  /** The key the conflict is about (a side's key; cross-key conflicts list several keys). */
  key,
  kind: conflictKindSchema,
  detectedBy: z.array(z.enum(RECONCILIATION_DECIDERS)).min(1),
  explanation: text(1200),
  /** Every conflicted fact of this conflict (the union of the sides). */
  factIds: z.array(z.uuid()).min(2),
  sides: z.array(conflictSideSchema).min(2),
});
export type FactConflict = z.infer<typeof factConflictSchema>;

const stripReasons = z.record(z.string().regex(/^[a-z_]+$/), count);

/** Counters on how much of the model's answer survived the code checks (for the eval). */
export const reconciliationDiagnosticsSchema = z.strictObject({
  modelCalled: z.boolean(),
  verifiedProposed: count,
  verifiedAccepted: count,
  /** Proposed verified facts that became a conflict (cited values disagree on one measure). */
  verifiedEscalated: count,
  verifiedDropped: stripReasons,
  conflictsProposed: count,
  conflictsAccepted: count,
  conflictsDropped: stripReasons,
  rejectionsProposed: count,
  rejectionsAccepted: count,
  rejectionsIgnored: stripReasons,
  /** Citations removed from otherwise valid entries, by reason. */
  citationsStripped: stripReasons,
  unknownEvidenceIds: count,
});
export type ReconciliationDiagnostics = z.infer<typeof reconciliationDiagnosticsSchema>;

/** Which model produced the judgment, and why the fallback ran if it did. */
export const reconciliationModelRunSchema = z.strictObject({
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  maxOutputTokens: z.int().positive(),
  /** Set when the primary model failed and the definition's fallback produced the result. */
  fallbackFrom: z
    .strictObject({
      model: z.string().min(1),
      reasoningEffort: z.string().min(1),
      /** Operator-safe failure class, e.g. `APICallError 503` (never an SDK message). */
      failure: z.string().min(1).max(120),
    })
    .nullable(),
});
export type ReconciliationModelRun = z.infer<typeof reconciliationModelRunSchema>;

/** Content of the `verified_fact_sheet` artifact (one per run and step). */
export const verifiedFactSheetContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  promptVersion: z.int().positive(),
  /** Null when no model call was needed (no transcript or photo candidates). */
  modelRun: reconciliationModelRunSchema.nullable(),
  counts: z.strictObject({
    candidates: count,
    verified: count,
    conflicted: count,
    rejected: count,
    entries: count,
    conflicts: count,
    basisNotes: count,
  }),
  entries: z.array(factSheetEntrySchema),
  basisNotes: z.array(basisNoteSchema),
  /** Exactly one per candidate fact the step read, in catalog order. */
  outcomes: z.array(factOutcomeSchema),
  diagnostics: reconciliationDiagnosticsSchema,
});
export type VerifiedFactSheetContent = z.infer<typeof verifiedFactSheetContentSchema>;

/** Content of the `fact_conflicts` artifact: what Gate 1 lists and resolves. */
export const factConflictsContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** The `verified_fact_sheet` artifact written in the same commit. */
  factSheetArtifactId: z.uuid(),
  conflicts: z.array(factConflictSchema),
});
export type FactConflictsContent = z.infer<typeof factConflictsContentSchema>;
