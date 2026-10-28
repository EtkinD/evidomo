import { z } from 'zod';
import {
  factAssertionSchema,
  factSourceSchema,
  factStatusSchema,
  runStatusSchema,
} from './domain.ts';
import {
  conflictKindSchema,
  conflictSideSchema,
  reconciledValueSchema,
  RECONCILIATION_DECIDERS,
} from './reconciliation.ts';

// Gate 1 API contracts (docs/architecture.md §5 "Gate 1 API"): listing the run's fact
// conflicts with their facts and provenance, and deciding them. Values and explanations describe
// the property (personal-data scope); they are returned to the run's owner only.

export const conflictIdSchema = z.string().regex(/^K\d{2,}$/);

/** Path parameters of the Gate 1 routes. */
export const gateRunParamsSchema = z.strictObject({ runId: z.uuid() });
export const gateConflictParamsSchema = z.strictObject({
  runId: z.uuid(),
  conflictId: conflictIdSchema,
});

const editText = z.string().trim().min(1).max(300);
/** A value the operator types: the same exact scalars reconciliation compares. */
const editedScalarSchema = z.union([z.number(), editText, z.boolean()]);

/**
 * `PUT /api/runs/:runId/gates/fact-conflicts/conflicts/:conflictId/decision`.
 *
 * - `accept`: the side holding `factId` is kept (all of its facts become `verified`); every
 *   other side's facts become `rejected`.
 * - `edit`: none of the sides is right; the operator states the value. Every conflicted fact
 *   becomes `rejected` and a new `gate_decision` fact carries the value. `key` defaults to the
 *   conflict's key and must be one of its sides' keys. For a market-profile key the profile
 *   fixes unit and basis (`unit`/`basis` may be omitted, or must match); for `other:` keys they
 *   default to null.
 * - `reject`: no value is kept; every conflicted fact becomes `rejected`.
 */
export const factConflictDecisionRequestSchema = z.discriminatedUnion('choice', [
  z.strictObject({ choice: z.literal('accept'), factId: z.uuid() }),
  z.strictObject({
    choice: z.literal('edit'),
    value: editedScalarSchema,
    key: z.string().min(1).max(80).optional(),
    unit: z.string().trim().min(1).max(40).nullable().optional(),
    basis: z.string().trim().min(1).max(40).nullable().optional(),
  }),
  z.strictObject({ choice: z.literal('reject') }),
]);
export type FactConflictDecisionRequest = z.input<typeof factConflictDecisionRequestSchema>;
/** The request after validation (strings trimmed). */
export type ParsedFactConflictDecisionRequest = z.output<typeof factConflictDecisionRequestSchema>;

/**
 * What an `edit` decision stores in `decisions.edited_value` (on every fact of the conflict) and
 * what the created fact carries, with defaults applied.
 */
export const factEditSchema = z.strictObject({
  key: z.string().min(1).max(80),
  value: reconciledValueSchema,
  unit: z.string().min(1).nullable(),
  basis: z.string().min(1).nullable(),
});
export type FactEdit = z.infer<typeof factEditSchema>;

const decidedAt = z.iso.datetime({ offset: true });

/** A conflict's decision, derived from its per-fact `decisions` rows; null while open. */
export const factConflictDecisionSchema = z.discriminatedUnion('choice', [
  z.strictObject({
    choice: z.literal('accept'),
    /** The accepted side's facts. */
    factIds: z.array(z.uuid()).min(1),
    decidedAt,
  }),
  z.strictObject({ choice: z.literal('edit'), ...factEditSchema.shape, decidedAt }),
  z.strictObject({ choice: z.literal('reject'), decidedAt }),
]);
export type FactConflictDecision = z.infer<typeof factConflictDecisionSchema>;

/** A conflicted fact with its provenance, so the UI can load the evidence (P4-06). */
export const gateFactSchema = z.strictObject({
  id: z.uuid(),
  key: z.string().min(1),
  value: z.json(),
  unit: z.string().nullable(),
  basis: z.string().nullable(),
  /** `conflicted` while the gate is open; `verified` / `rejected` once it is released. */
  status: factStatusSchema,
  assertion: factAssertionSchema,
  source: factSourceSchema,
});
export type GateFact = z.infer<typeof gateFactSchema>;

export const gateConflictSideSchema = z.strictObject({
  ...conflictSideSchema.shape,
  /** The side's facts, in the order of `factIds`. */
  facts: z.array(gateFactSchema).min(1),
});
export type GateConflictSide = z.infer<typeof gateConflictSideSchema>;

export const gateConflictSchema = z.strictObject({
  id: conflictIdSchema,
  key: z.string().min(1),
  kind: conflictKindSchema,
  detectedBy: z.array(z.enum(RECONCILIATION_DECIDERS)).min(1),
  explanation: z.string().min(1),
  sides: z.array(gateConflictSideSchema).min(2),
  decision: factConflictDecisionSchema.nullable(),
});
export type GateConflict = z.infer<typeof gateConflictSchema>;

/**
 * - `not_reached`: reconciliation has not stored its conflicts yet.
 * - `open`: the run is paused at Gate 1; decisions are accepted.
 * - `released`: the gate was released (last decision, or nothing to decide); read-only.
 * - `suspended`: the gate holds but the run is not waiting (it failed there); a run resume
 *   reopens it with the decisions made so far.
 */
export const FACT_CONFLICTS_GATE_STATES = ['not_reached', 'open', 'released', 'suspended'] as const;
export const factConflictsGateStateSchema = z.enum(FACT_CONFLICTS_GATE_STATES);
export type FactConflictsGateState = z.infer<typeof factConflictsGateStateSchema>;

/** `GET /api/runs/:runId/gates/fact-conflicts` (200). */
export const factConflictsGateResponseSchema = z.strictObject({
  runId: z.uuid(),
  runStatus: runStatusSchema,
  state: factConflictsGateStateSchema,
  /** The reconciliation artifacts; null before the gate is reached. */
  factSheetArtifactId: z.uuid().nullable(),
  conflictsArtifactId: z.uuid().nullable(),
  conflictCount: z.int().nonnegative(),
  openCount: z.int().nonnegative(),
  conflicts: z.array(gateConflictSchema),
});
export type FactConflictsGateResponse = z.infer<typeof factConflictsGateResponseSchema>;

/** `PUT .../conflicts/:conflictId/decision` (200): the gate after the decision. */
export const factConflictDecisionResponseSchema = z.strictObject({
  ...factConflictsGateResponseSchema.shape,
  /** This request decided the last open conflict, released the gate, and resumed the run. */
  resumed: z.boolean(),
});
export type FactConflictDecisionResponse = z.infer<typeof factConflictDecisionResponseSchema>;
