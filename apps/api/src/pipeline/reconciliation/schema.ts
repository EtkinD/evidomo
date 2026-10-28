import { FACT_ASSERTIONS } from '@evidomo/shared';
import { z } from 'zod';

// Reconciliation input and output contracts, first measured in P1-03 (docs/model-notes.md) and
// the starting point for the P2-09 step. The model only ever sees short evidence IDs; mapping an
// ID to its stored provenance (form field, transcript turn with timestamps, photo region) happens
// in code, so the model never has to echo timestamps or coordinates.

/** Form field IDs, e.g. `F.living_area`. */
export const FORM_ID_PATTERN = /^F\.[a-z][a-z0-9_]*$/;
/** Transcript turn IDs, e.g. `T03`. */
export const TURN_ID_PATTERN = /^T\d{2,3}$/;
/** Candidate fact IDs, e.g. `C05`. */
export const CANDIDATE_ID_PATTERN = /^C\d{2,3}$/;
/** Photo IDs, e.g. `P05`. */
export const PHOTO_ID_PATTERN = /^P\d{2,3}$/;
/** Photo region IDs, e.g. `P05.R1`. */
export const PHOTO_REGION_ID_PATTERN = /^P\d{2,3}\.R\d+$/;
/** Inventory aggregate IDs, e.g. `INV1`. */
export const INVENTORY_ID_PATTERN = /^INV\d+$/;

const factValueSchema = z.union([z.number(), z.string()]);
/**
 * Input values also take booleans: the fact form stores boolean market facts (`ground_lease`)
 * as JSON booleans, and P2-07 candidates keep them so (yes/no facts).
 */
const evidenceValueSchema = z.union([z.number(), z.string(), z.boolean()]);

const formFieldSchema = z.object({
  id: z.string().regex(FORM_ID_PATTERN),
  field: z.string().min(1),
  /** `null` means the agent left the field empty (unknown), not "zero" or "no". */
  value: evidenceValueSchema.nullable(),
  unit: z.string().nullable(),
  /** Measurement basis for areas and volumes, e.g. `NEN2580`; `null` when not applicable. */
  basis: z.string().nullable(),
});

const transcriptTurnSchema = z
  .object({
    turnId: z.string().regex(TURN_ID_PATTERN),
    /**
     * A role (`agent`, `seller`) or the transcription's diarization label (`A`, P2-06); `null`
     * when the transcript has no speaker labels.
     */
    speaker: z.string().min(1).nullable(),
    startMs: z.int().nonnegative(),
    endMs: z.int().nonnegative(),
    text: z.string().min(1),
  })
  .refine((turn) => turn.endMs > turn.startMs, { message: 'endMs must be after startMs' });

const candidateFactSchema = z.object({
  id: z.string().regex(CANDIDATE_ID_PATTERN),
  key: z.string().min(1),
  value: evidenceValueSchema,
  unit: z.string().nullable(),
  basis: z.string().nullable(),
  /** P2-07 marks opinions; they can never become verified facts (database check). */
  assertion: z.enum(FACT_ASSERTIONS).optional(),
  /** Verbatim span of the turn the candidate was extracted from. */
  quote: z.string().min(1),
  turnId: z.string().regex(TURN_ID_PATTERN),
  startMs: z.int().nonnegative(),
  endMs: z.int().nonnegative(),
});

const photoObservationSchema = z.object({
  id: z.string().regex(PHOTO_REGION_ID_PATTERN),
  label: z.string().min(1),
  detail: z.string().min(1),
});

const photoSchema = z.object({
  photoId: z.string().regex(PHOTO_ID_PATTERN),
  room: z.string().min(1),
  summary: z.string().min(1),
  observations: z.array(photoObservationSchema).min(1),
});

const inventoryAggregateSchema = z.object({
  id: z.string().regex(INVENTORY_ID_PATTERN),
  key: z.string().min(1),
  value: factValueSchema,
  photoIds: z.array(z.string().regex(PHOTO_ID_PATTERN)).min(1),
  detail: z.string().min(1),
});

export const reconciliationInputSchema = z
  .object({
    property: z.object({
      label: z.string().min(1),
      market: z.string().min(1),
      propertyType: z.string().min(1),
      sourceLanguage: z.string().min(2),
      outputLanguage: z.string().min(2),
    }),
    form: z.array(formFieldSchema).min(1),
    transcript: z.array(transcriptTurnSchema),
    candidates: z.array(candidateFactSchema),
    photos: z.array(photoSchema),
    inventory: z.array(inventoryAggregateSchema),
  })
  .superRefine((input, ctx) => {
    const ids = evidenceIdList(input);
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `Duplicate evidence ID ${id}` });
      seen.add(id);
    }
    const turns = new Map(input.transcript.map((turn) => [turn.turnId, turn]));
    for (const candidate of input.candidates) {
      const turn = turns.get(candidate.turnId);
      if (turn === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${candidate.id} cites unknown turn ${candidate.turnId}`,
        });
      } else if (candidate.startMs !== turn.startMs || candidate.endMs !== turn.endMs) {
        ctx.addIssue({
          code: 'custom',
          message: `${candidate.id} timestamps differ from turn ${turn.turnId}`,
        });
      } else if (!turn.text.includes(candidate.quote)) {
        ctx.addIssue({
          code: 'custom',
          message: `${candidate.id} quote is not verbatim from ${turn.turnId}`,
        });
      }
    }
    const photoIds = new Set(input.photos.map((photo) => photo.photoId));
    for (const photo of input.photos) {
      for (const observation of photo.observations) {
        if (!observation.id.startsWith(`${photo.photoId}.`)) {
          ctx.addIssue({
            code: 'custom',
            message: `${observation.id} is listed under ${photo.photoId}`,
          });
        }
      }
    }
    for (const aggregate of input.inventory) {
      for (const photoId of aggregate.photoIds) {
        if (!photoIds.has(photoId)) {
          ctx.addIssue({ code: 'custom', message: `${aggregate.id} cites unknown ${photoId}` });
        }
      }
    }
  });

export type ReconciliationInput = z.infer<typeof reconciliationInputSchema>;
export type FormField = ReconciliationInput['form'][number];
export type CandidateFact = ReconciliationInput['candidates'][number];

/** Every citable evidence ID (form fields, candidates, photo regions, inventory aggregates). */
function evidenceIdList(input: ReconciliationInput): string[] {
  return [
    ...input.form.map((field) => field.id),
    ...input.candidates.map((candidate) => candidate.id),
    ...input.photos.flatMap((photo) => photo.observations.map((observation) => observation.id)),
    ...input.inventory.map((aggregate) => aggregate.id),
  ];
}

export function evidenceIds(input: ReconciliationInput): ReadonlySet<string> {
  return new Set(evidenceIdList(input));
}

/**
 * The value an evidence item asserts, for the exact-number check. Photo observations carry no
 * value (they support presence, not numbers), so they return `undefined`.
 */
export function evidenceValue(
  input: ReconciliationInput,
  id: string,
): number | string | boolean | null | undefined {
  const form = input.form.find((field) => field.id === id);
  if (form !== undefined) return form.value;
  const candidate = input.candidates.find((item) => item.id === id);
  if (candidate !== undefined) return candidate.value;
  const aggregate = input.inventory.find((item) => item.id === id);
  if (aggregate !== undefined) return aggregate.value;
  return undefined;
}

// Output (strict json_schema). No `.optional()`, `.min()`, or other constraints that strict mode
// cannot express: every field is required and nullable where absent. Invariants that need code
// (known IDs, exact numbers, conflicted facts not verified) are checked after parsing.

const verifiedFactSchema = z.object({
  key: z.string().describe('snake_case English fact name, e.g. living_area'),
  value: factValueSchema.describe('number copied exactly from the evidence, or English text'),
  unit: z.string().nullable(),
  basis: z.string().nullable().describe('measurement basis for areas/volumes, else null'),
  evidenceIds: z.array(z.string()).describe('every catalog ID that supports this fact'),
});

const conflictSideSchema = z.object({
  evidenceId: z.string(),
  value: factValueSchema,
  unit: z.string().nullable(),
  basis: z.string().nullable(),
  statement: z.string().describe('short English paraphrase of what this evidence says'),
});

const conflictSchema = z.object({
  key: z.string(),
  kind: z.enum(['value_mismatch', 'count_mismatch', 'presence_mismatch', 'other']),
  sides: z.array(conflictSideSchema).describe('at least two sides, one per evidence item'),
  explanation: z.string(),
});

const distinctBasisNoteSchema = z.object({
  key: z.string(),
  evidenceIds: z.array(z.string()),
  explanation: z.string().describe('why these values are different measures, not a conflict'),
});

const rejectedCandidateSchema = z.object({
  evidenceId: z.string(),
  reason: z.enum(['opinion', 'unsupported', 'duplicate', 'out_of_scope']),
  explanation: z.string(),
});

export const reconciliationOutputSchema = z.object({
  verifiedFacts: z.array(verifiedFactSchema),
  conflicts: z.array(conflictSchema),
  distinctBasisNotes: z.array(distinctBasisNoteSchema),
  rejected: z.array(rejectedCandidateSchema),
});

export type ReconciliationOutput = z.infer<typeof reconciliationOutputSchema>;
