import { FACT_ASSERTIONS, type FactAssertion, type MarketProfile } from '@evidomo/shared';
import { z } from 'zod';

// Fact extraction contracts (docs/architecture.md §5 step 2, §8 `facts`). The model sees a
// closed vocabulary (market fact keys plus "other", the profile's area bases plus
// "unspecified"); `normalize.ts` re-checks every field in code, because strict mode constrains
// the shape of the answer, not its truth.

/** Prefix of keys outside the market profile. Reconciliation treats them as non-core facts. */
export const OTHER_KEY_PREFIX = 'other:';
/** The model's key for a fact outside the profile; the name goes into `otherKey`. */
export const OTHER_KEY = 'other';
/** Basis of an area whose measurement standard was not stated. */
export const UNSPECIFIED_BASIS = 'unspecified';
/** `snake_case` names after `other:`. */
export const OTHER_SLUG_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const FACT_EXTRACTION_ARTIFACT_KIND = 'fact_extraction';
/** Bumped whenever the prompt or output schema changes meaning; stored in the report. */
export const FACT_EXTRACTION_PROMPT_VERSION = 1;

/** Units a fact may carry in this market: area, volume, and currency, as far as defined. */
export function marketUnits(market: MarketProfile): string[] {
  return [market.units.area, market.units.volume, market.currency].filter(
    (unit): unit is string => unit !== undefined,
  );
}

function nonEmptyEnum(values: readonly string[], what: string): z.ZodEnum<Record<string, string>> {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error(`The market profile defines no ${what}`);
  return z.enum([first, ...rest]);
}

/**
 * The strict output schema for one market. Every field is required and nullable where absent
 * (Meta enforces strict `json_schema` server-side; `.optional()` is rejected). Integer and range
 * checks are done in code: strict mode is not relied on for `minimum`/`maximum`.
 */
export function buildExtractionOutputSchema(market: MarketProfile) {
  const fact = z.object({
    turnIndex: z.number().describe('index of the turn in which the fact is said'),
    quote: z
      .string()
      .describe(
        'shortest exact span of that turn that states the fact, copied character for character',
      ),
    key: nonEmptyEnum([...market.facts.map((item) => item.key), OTHER_KEY], 'fact keys'),
    otherKey: z
      .string()
      .nullable()
      .describe('snake_case English name when key is "other", else null'),
    value: z.union([z.number(), z.string(), z.boolean()]),
    unit: nonEmptyEnum(marketUnits(market), 'units').nullable(),
    basis: nonEmptyEnum(
      [...market.area_bases.map((basis) => basis.id), UNSPECIFIED_BASIS],
      'area bases',
    )
      .nullable()
      .describe('areas only: a basis ID the speaker names, else "unspecified"; null for non-areas'),
    assertion: z.enum(FACT_ASSERTIONS),
  });
  return z.object({ facts: z.array(fact) });
}

export type ExtractionOutputSchema = ReturnType<typeof buildExtractionOutputSchema>;

/**
 * One fact as the model returned it, typed loosely on purpose: normalization must cope with any
 * value in any field, whatever the schema promised.
 */
export interface RawExtractedFact {
  readonly turnIndex: number;
  readonly quote: string;
  readonly key: string;
  readonly otherKey: string | null;
  readonly value: number | string | boolean;
  readonly unit: string | null;
  readonly basis: string | null;
  readonly assertion: string;
}

export type FactValue = number | string | boolean;

/**
 * A candidate fact before it is stored. Field names follow the reconciliation catalog
 * (`pipeline/reconciliation/schema.ts`: `key`, `value`, `unit`, `basis`, `quote`, `startMs`,
 * `endMs`), so P2-09 only assigns catalog IDs.
 */
export interface TranscriptCandidate {
  readonly key: string;
  readonly value: FactValue;
  readonly unit: string | null;
  readonly basis: string | null;
  readonly assertion: FactAssertion;
  readonly turnIndex: number;
  readonly startMs: number;
  readonly endMs: number;
  /** The exact span of the turn's text (verified in code), not the model's copy. */
  readonly quote: string;
  /** The key, unit, basis, value, or assertion was changed by a deterministic repair. */
  readonly repaired: boolean;
}

export interface FormCandidate {
  readonly key: string;
  readonly value: FactValue;
  readonly unit: string | null;
  readonly basis: string | null;
  /** The fact-form field the value came from (`facts.source_ref.field`). */
  readonly field: string;
}

export const EXTRACTION_REJECTION_REASONS = [
  'unknown_turn',
  'quote_mismatch',
  'invalid_key',
  'invalid_value',
  'unit_mismatch',
  'duplicate',
] as const;
export type ExtractionRejectionReason = (typeof EXTRACTION_REJECTION_REASONS)[number];

/** Upper bound on stored model text in the report (a runaway quote must not bloat the row). */
export const REPORT_TEXT_LIMIT = 300;

const reportText = z.string().max(REPORT_TEXT_LIMIT);
const count = z.int().nonnegative();

/**
 * Content of the `fact_extraction` artifact: what the step sent and what validation did with
 * the model's answer. Rejected entries hold model output and transcript spans, so the artifact
 * has the transcript's personal-data scope (it cascades with the run and project); events carry
 * only the counts.
 */
export const factExtractionReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  promptVersion: z.int().positive(),
  transcriptArtifactId: z.uuid(),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  maxOutputTokens: z.int().positive(),
  counts: z.strictObject({
    formFacts: count,
    /** Form fields that are neither market facts nor scalar `other:` values (not stored). */
    skippedFormFields: count,
    modelFacts: count,
    transcriptFacts: count,
    opinionFacts: count,
    repairedFacts: count,
    rejected: z.strictObject({
      unknown_turn: count,
      quote_mismatch: count,
      invalid_key: count,
      invalid_value: count,
      unit_mismatch: count,
      duplicate: count,
    } satisfies Record<ExtractionRejectionReason, typeof count>),
  }),
  rejected: z.array(
    z.strictObject({
      reason: z.enum(EXTRACTION_REJECTION_REASONS),
      turnIndex: z.number(),
      key: reportText,
      quote: reportText,
    }),
  ),
});
export type FactExtractionReport = z.infer<typeof factExtractionReportSchema>;
