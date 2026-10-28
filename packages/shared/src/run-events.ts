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
