import { z } from 'zod';
import { gateSchema, usdAmountSchema } from './domain.ts';
import { turnTranscriptionModeSchema } from './transcription.ts';

// Payloads of the run events the run engine appends (docs/architecture.md §9). They feed the
// run monitor over SSE and demo replay, so they carry IDs, counters, costs, and operator-safe
// reasons only: never model output, customer content, or raw error messages.

const stepRef = {
  stepId: z.string().min(1),
  /** Scheduling scope of the step within the run; a resume after failure starts a new one. */
  attempt: z.int().positive(),
};

/** Handler execution within an attempt (1 or 2: a transient failure is retried once). */
const execution = z.int().positive();

/** Exact decimal strings from the usage ledger, never floats. */
const costs = {
  /** Every ledger row of this step in this run, across attempts and executions. */
  stepCostUsd: usdAmountSchema,
  runCostUsd: usdAmountSchema,
};

export const stepStartedPayloadSchema = z.strictObject({ ...stepRef, execution });
export type StepStartedPayload = z.infer<typeof stepStartedPayloadSchema>;

export const stepCompletedPayloadSchema = z.strictObject({
  ...stepRef,
  execution,
  artifactIds: z.array(z.uuid()),
  ...costs,
});
export type StepCompletedPayload = z.infer<typeof stepCompletedPayloadSchema>;

export const stepFailedPayloadSchema = z.strictObject({
  ...stepRef,
  execution,
  /** Operator-safe description, e.g. `Step "intake" timed out after 600 s`. */
  reason: z.string().min(1),
  /** `true` when the same attempt runs again; `false` when the run fails with this step. */
  willRetry: z.boolean(),
  ...costs,
});
export type StepFailedPayload = z.infer<typeof stepFailedPayloadSchema>;

export const gateOpenedPayloadSchema = z.strictObject({
  gate: gateSchema,
  /** The completed step whose `gate_after` opened the gate. */
  stepId: z.string().min(1),
});
export type GateOpenedPayload = z.infer<typeof gateOpenedPayloadSchema>;

/**
 * Appended once, when the last open item of a gate is decided, in the transaction that applies
 * the decisions and resumes the run. Counts only: never keys, values, or edited text.
 */
export const gateDecidedPayloadSchema = z.strictObject({
  gate: gateSchema,
  /** The completed step whose `gate_after` is released. */
  stepId: z.string().min(1),
  /** Gate 1: conflicts resolved by accepting a side, by an edited value, or by rejecting all. */
  acceptedCount: z.int().nonnegative(),
  editedCount: z.int().nonnegative(),
  rejectedCount: z.int().nonnegative(),
  /** Facts set to `verified` / `rejected`, and facts created from edited values. */
  verifiedFactCount: z.int().nonnegative(),
  rejectedFactCount: z.int().nonnegative(),
  createdFactCount: z.int().nonnegative(),
});
export type GateDecidedPayload = z.infer<typeof gateDecidedPayloadSchema>;

/** Appended after every metered model call, so the run monitor shows spend while a step runs. */
export const usageRecordedPayloadSchema = z.strictObject({
  stepId: z.string().min(1),
  ...costs,
});
export type UsageRecordedPayload = z.infer<typeof usageRecordedPayloadSchema>;

const count = z.int().nonnegative();

/**
 * Appended by the intake step together with its transcript artifact: a summary for the run
 * monitor. Counts only: transcript text and keywords are personal data and never go into events.
 */
export const transcriptStoredPayloadSchema = z.strictObject({
  stepId: z.string().min(1),
  artifactId: z.uuid(),
  mode: turnTranscriptionModeSchema,
  audioDurationMs: count,
  /** Turns as returned by the API (non-empty ones). */
  sourceTurnCount: count,
  /** Stored turns, after long turns were split. */
  turnCount: count,
  /** Stored turns whose timestamps were interpolated. */
  approximateTurnCount: count,
  speakerCount: count,
  keywordCount: count,
});
export type TranscriptStoredPayload = z.infer<typeof transcriptStoredPayloadSchema>;

/**
 * Appended by the fact extraction step together with its candidate facts: counts for the run
 * monitor. Never fact keys, values, quotes, or transcript text.
 */
export const factsExtractedPayloadSchema = z.strictObject({
  stepId: z.string().min(1),
  /** The step's `fact_extraction` report artifact. */
  artifactId: z.uuid(),
  /** Candidate facts stored from the fact form (no model call). */
  formFactCount: count,
  /** Facts the model returned, before validation. */
  modelFactCount: count,
  /** Transcript facts stored after validation (opinions included). */
  transcriptFactCount: count,
  /** Stored transcript facts marked as opinions. */
  opinionCount: count,
  /** Stored transcript facts whose key, unit, basis, or value was repaired deterministically. */
  repairedCount: count,
  /** Model facts dropped by validation (unknown turn, quote mismatch, invalid key or value, ...). */
  rejectedCount: count,
});
export type FactsExtractedPayload = z.infer<typeof factsExtractedPayloadSchema>;

/**
 * Appended by the vision inventory step together with its `photo_inventory` artifact and photo
 * facts: counts for the run monitor. Never subjects, summaries, or observed objects.
 */
export const photosInventoriedPayloadSchema = z.strictObject({
  stepId: z.string().min(1),
  /** The step's `photo_inventory` artifact. */
  artifactId: z.uuid(),
  photoCount: count,
  classifiedCount: count,
  classificationFailedCount: count,
  privacyClearCount: count,
  privacyMaskedCount: count,
  /** Spark saw a privacy subject that SAM did not segment: a human must look before export. */
  privacyReviewCount: count,
  /** A privacy segmentation failed: these photos are not privacy-checked. */
  privacyFailedCount: count,
  privacyRegionCount: count,
  observationCount: count,
  evidenceRequestCount: count,
  evidenceMaskCount: count,
  factCount: count,
});
export type PhotosInventoriedPayload = z.infer<typeof photosInventoriedPayloadSchema>;

/**
 * Appended by the reconciliation step together with its `verified_fact_sheet` and
 * `fact_conflicts` artifacts: counts for the run monitor. A run with conflicts stops at Gate 1;
 * without conflicts the gate is released and the run continues. Never keys, values, or
 * explanations.
 */
export const factsReconciledPayloadSchema = z.strictObject({
  stepId: z.string().min(1),
  /** The step's `verified_fact_sheet` artifact. */
  artifactId: z.uuid(),
  /** The step's `fact_conflicts` artifact (empty when there is nothing to decide). */
  conflictsArtifactId: z.uuid(),
  candidateCount: count,
  verifiedCount: count,
  conflictedCount: count,
  rejectedCount: count,
  entryCount: count,
  conflictCount: count,
  basisNoteCount: count,
  /** The model whose judgment was used; null when no call was needed. */
  model: z.string().min(1).nullable(),
  /** The primary model failed and the definition's fallback produced the result. */
  fallbackUsed: z.boolean(),
});
export type FactsReconciledPayload = z.infer<typeof factsReconciledPayloadSchema>;
