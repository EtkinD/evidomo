import { z } from 'zod';
import { compareDecimalStrings } from './decimal.ts';
import { gateSchema, usdAmountSchema } from './domain.ts';
import { findModelPrice, PRICE_TABLE } from './prices.ts';
import { metaReasoningEffortSchema } from './reasoning.ts';
import {
  TRANSCRIPTION_KEYWORD_LIMITS,
  transcriptionKeywordSchema,
  turnTranscriptionModeSchema,
} from './transcription.ts';

// Schemas for the declarative definition files in `definitions/` (docs/architecture.md §7):
// service definitions (`definitions/services/<id>.v<version>.yaml`) and market profiles
// (`definitions/markets/<id>.v<version>.yaml`). They live in `shared` because the web fact form
// is generated from the market profile schema. Objects are strict: an unknown key is an error,
// so a typo cannot silently drop a setting. The api loader parses the YAML and reports issues
// with file, line, and path.

// ---------------------------------------------------------------------------------------------
// Common building blocks
// ---------------------------------------------------------------------------------------------

/** `listing-launch`, `nl`, `international`. Also the file-name stem before `.v<version>`. */
export const definitionIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'Expected a lowercase kebab-case ID');

/** Versions are immutable once published: a change is a new file with the next version. */
export const definitionVersionSchema = z.int().positive();

const keySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'Expected a lowercase snake_case key')
  .max(64);

const labelSchema = z.string().trim().min(1).max(200);

/**
 * A Meta model ID. Contributor-mode variants are rejected here as well as in the meta module's
 * fetch wrapper (Standard mode only, docs/architecture.md §1 principle 6).
 */
export const modelIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]*$/, 'Expected a model ID such as "muse-spark-1.3"')
  .refine((id) => !id.endsWith('-contributor'), {
    message: 'Contributor-mode model IDs are forbidden (Standard mode only)',
  });

const languageDisplayNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/** An ISO 639-1 language code that the runtime's ICU data knows (`en`, `nl`, `tr`, ...). */
export const languageCodeSchema = z
  .string()
  .regex(/^[a-z]{2}$/, 'Expected a lowercase two-letter ISO 639-1 language code')
  .refine((code) => languageDisplayNames.of(code) !== undefined, {
    message: 'Unknown ISO 639-1 language code',
  });

/** Reports every value that occurs more than once, at the path of its second occurrence. */
function checkUnique(
  ctx: z.RefinementCtx,
  values: readonly string[],
  pathOf: (index: number) => PropertyKey[],
  what: string,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({
        code: 'custom',
        path: pathOf(index),
        message: `Duplicate ${what} "${value}"`,
      });
    }
    seen.add(value);
  });
}

// ---------------------------------------------------------------------------------------------
// Service definitions
// ---------------------------------------------------------------------------------------------

/** Step implementations the run engine knows. A step names one; unknown agents fail at boot. */
export const STEP_AGENTS = [
  'intake',
  'extractor',
  'vision',
  'reconciler',
  'creative',
  'qa_writer',
  'integrity_checker',
  'verifier',
  'exporter',
] as const;
export const stepAgentSchema = z.enum(STEP_AGENTS);
export type StepAgent = z.infer<typeof stepAgentSchema>;

// Muse Voice Transcribe accepts at most 10 minutes of audio (docs/architecture.md §4).
const MAX_VOICE_SECONDS = 600;

const stepCommon = {
  id: keySchema,
  /** The run pauses at this human gate after the step completes. */
  gate_after: gateSchema.optional(),
};

/**
 * A reasoning language-model call (Spark, Wonder; both accept the same effort set, P1-03).
 *
 * - `reasoning_effort` is required: Spark's API default is `high`, which costs several times
 *   `low` (docs/model-notes.md, P1-02), so every step states its own.
 * - `max_output_tokens` is required because reasoning tokens are billed as output: it bounds the
 *   worst-case cost of one call (per call, e.g. per photo in vision inventory).
 * - The fallback (used when the primary model is unavailable) states its own effort, because a
 *   weaker fallback may need a higher one; `fallback_reasoning_effort` is required exactly when
 *   `fallback_model` is set (checked in the definition refinement).
 */
const reasoningModelFields = {
  model: modelIdSchema,
  reasoning_effort: metaReasoningEffortSchema,
  // The upper bound is a guard against typos (an extra zero), not a documented API limit.
  max_output_tokens: z.int().positive().max(128_000),
  fallback_model: modelIdSchema.optional(),
  fallback_reasoning_effort: metaReasoningEffortSchema.optional(),
};

export const serviceStepSchema = z.discriminatedUnion('agent', [
  z.strictObject({
    ...stepCommon,
    agent: z.literal('intake'),
    model: modelIdSchema,
    /**
     * Required, like reasoning efforts: the API default (`PUSH_TO_TALK`) returns no turns, and
     * turns are the evidence anchors of transcript claims.
     */
    transcription_mode: turnTranscriptionModeSchema,
    /**
     * API turns longer than this are split into chunks with interpolated (`approximate`)
     * timestamps, so evidence playback can start near the cited sentence. Omit to store turns
     * exactly as the API returned them.
     */
    max_turn_seconds: z.int().min(5).max(MAX_VOICE_SECONDS).optional(),
  }),
  z.strictObject({ ...stepCommon, agent: z.literal('extractor'), ...reasoningModelFields }),
  z.strictObject({
    ...stepCommon,
    agent: z.literal('vision'),
    ...reasoningModelFields,
    segmentation_model: modelIdSchema,
    /** Cap on SAM evidence-region requests per run (privacy masks are not capped). */
    max_evidence_masks: z.int().min(0).max(100),
  }),
  z.strictObject({ ...stepCommon, agent: z.literal('reconciler'), ...reasoningModelFields }),
  z.strictObject({
    ...stepCommon,
    agent: z.literal('creative'),
    ...reasoningModelFields,
    image_model: modelIdSchema,
  }),
  z.strictObject({ ...stepCommon, agent: z.literal('qa_writer'), ...reasoningModelFields }),
  z.strictObject({
    ...stepCommon,
    agent: z.literal('integrity_checker'),
    segmentation_model: modelIdSchema,
  }),
  z.strictObject({
    ...stepCommon,
    agent: z.literal('verifier'),
    ...reasoningModelFields,
    /** Verification → creative revision loops before remaining flags go to Gate 2. */
    max_revision_loops: z.int().min(0).max(5),
  }),
  z.strictObject({ ...stepCommon, agent: z.literal('exporter') }),
]);
export type ServiceStep = z.infer<typeof serviceStepSchema>;

/** Every model ID a step names, by field; each must be priced. */
export function stepModelIds(step: ServiceStep): { field: string; modelId: string }[] {
  const fields: [string, string | undefined][] = [
    ['model', 'model' in step ? step.model : undefined],
    ['fallback_model', 'fallback_model' in step ? step.fallback_model : undefined],
    ['segmentation_model', 'segmentation_model' in step ? step.segmentation_model : undefined],
    ['image_model', 'image_model' in step ? step.image_model : undefined],
  ];
  return fields.flatMap(([field, modelId]) => (modelId === undefined ? [] : [{ field, modelId }]));
}

export const serviceInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    key: keySchema,
    type: z.literal('images'),
    min: z.int().min(1),
    max: z.int().min(1).max(100),
    required: z.boolean(),
  }),
  z.strictObject({
    key: keySchema,
    type: z.literal('audio'),
    max_seconds: z.int().min(1).max(MAX_VOICE_SECONDS),
    required: z.boolean(),
  }),
  z.strictObject({
    key: keySchema,
    type: z.literal('form'),
    /** The fact form's fields come from the run's market profile. */
    schema: z.literal('from_market_profile'),
    source_of_truth: z.boolean(),
    required: z.boolean(),
  }),
]);
export type ServiceInput = z.infer<typeof serviceInputSchema>;

/**
 * A run budget as an exact decimal string. YAML parses an unquoted `0.50` as a float, so a
 * number is rejected instead of coerced: the value reaches the usage ledger without ever being
 * a float.
 */
const runBudgetUsdSchema = z
  .string({
    error: (issue) =>
      issue.input === undefined
        ? 'Required'
        : 'Expected a quoted decimal string such as "0.50" (an unquoted YAML number is a float)',
  })
  .pipe(usdAmountSchema)
  .refine((value) => compareDecimalStrings(value, '0') > 0, {
    message: 'The run budget must be greater than zero',
  });

export const serviceDefinitionSchema = z
  .strictObject({
    id: definitionIdSchema,
    version: definitionVersionSchema,
    name: labelSchema,
    inputs: z.array(serviceInputSchema).min(1),
    steps: z.array(serviceStepSchema).min(1),
    budget: z.strictObject({ max_cost_usd_per_run: runBudgetUsdSchema }),
  })
  .superRefine((service, ctx) => {
    checkUnique(
      ctx,
      service.inputs.map((input) => input.key),
      (i) => ['inputs', i, 'key'],
      'input key',
    );
    service.inputs.forEach((input, i) => {
      if (input.type === 'images' && input.min > input.max) {
        ctx.addIssue({ code: 'custom', path: ['inputs', i, 'min'], message: 'min exceeds max' });
      }
    });

    checkUnique(
      ctx,
      service.steps.map((step) => step.id),
      (i) => ['steps', i, 'id'],
      'step ID',
    );
    const gated = service.steps.flatMap((step, i) =>
      step.gate_after === undefined ? [] : [{ gate: step.gate_after, i }],
    );
    checkUnique(
      ctx,
      gated.map((g) => g.gate),
      (n) => ['steps', gated[n]?.i ?? 0, 'gate_after'],
      'gate',
    );

    service.steps.forEach((step, i) => {
      for (const { field, modelId } of stepModelIds(step)) {
        if (findModelPrice(PRICE_TABLE, modelId) === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, field],
            message: `Model "${modelId}" has no entry in the shared price table (PRICE_TABLE), so its calls could not be metered`,
          });
        }
      }
      if (!('reasoning_effort' in step)) return;
      if (step.fallback_model === step.model) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'fallback_model'],
          message: 'fallback_model must differ from model',
        });
      }
      if (step.fallback_model !== undefined && step.fallback_reasoning_effort === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'fallback_reasoning_effort'],
          message: 'fallback_reasoning_effort is required when fallback_model is set',
        });
      }
      if (step.fallback_model === undefined && step.fallback_reasoning_effort !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'fallback_reasoning_effort'],
          message: 'fallback_reasoning_effort is only allowed together with fallback_model',
        });
      }
      // Reasoning effort controls reasoning tokens, so it only applies to token-billed models.
      for (const field of ['model', 'fallback_model'] as const) {
        const modelId = step[field];
        const price = modelId === undefined ? undefined : findModelPrice(PRICE_TABLE, modelId);
        if (price !== undefined && price.billing !== 'tokens') {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, field],
            message: `Model "${modelId}" is billed per ${price.billing}, not per token, and cannot take a reasoning_effort`,
          });
        }
      }
    });
  });
export type ServiceDefinition = z.infer<typeof serviceDefinitionSchema>;

/** The top-level shape of a service definition file. */
export const serviceDefinitionFileSchema = z.strictObject({ service: serviceDefinitionSchema });

// ---------------------------------------------------------------------------------------------
// Market profiles
// ---------------------------------------------------------------------------------------------

export const AREA_UNITS = ['m2', 'sq_ft'] as const;
export const areaUnitSchema = z.enum(AREA_UNITS);
export type AreaUnit = z.infer<typeof areaUnitSchema>;

export const VOLUME_UNITS = ['m3', 'cu_ft'] as const;
export const volumeUnitSchema = z.enum(VOLUME_UNITS);
export type VolumeUnit = z.infer<typeof volumeUnitSchema>;

/** Phrasing categories the verifier checks; each needs verifier support, so the set is closed. */
export const PHRASING_CATEGORIES = [
  'exclusionary',
  'investment_promise',
  'unverifiable_superlative',
] as const;
export const phrasingCategorySchema = z.enum(PHRASING_CATEGORIES);
export type PhrasingCategory = z.infer<typeof phrasingCategorySchema>;

/** `NEN2580`, `net_internal`, ... */
const areaBasisIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Expected an area basis ID such as "NEN2580"')
  .max(64);

export const areaBasisSchema = z.strictObject({ id: areaBasisIdSchema, label: labelSchema });
export type AreaBasis = z.infer<typeof areaBasisSchema>;

const factCommon = {
  key: keySchema,
  label: labelSchema,
  /** Required facts must be filled in the fact form before a run starts. */
  required: z.boolean().default(false),
};

// Facts are scalar so the fact form and the Verified Fact Sheet stay flat: a structured value
// (e.g. ground lease terms) is modeled as several facts.
export const marketFactSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...factCommon,
    type: z.literal('enum'),
    values: z.array(z.string().trim().min(1).max(40)).min(2),
  }),
  z.strictObject({
    ...factCommon,
    type: z.literal('area'),
    /** Areas are compared as value + unit + basis; the unit is the profile's `units.area`. */
    basis: areaBasisIdSchema,
  }),
  z.strictObject({ ...factCommon, type: z.literal('volume') }),
  z.strictObject({
    ...factCommon,
    type: z.literal('integer'),
    min: z.int().optional(),
    max: z.int().optional(),
  }),
  /** An amount in the profile's `currency`. */
  z.strictObject({ ...factCommon, type: z.literal('money') }),
  z.strictObject({ ...factCommon, type: z.literal('boolean') }),
]);
export type MarketFact = z.infer<typeof marketFactSchema>;
export type MarketFactType = MarketFact['type'];

const checklistCommon = { id: keySchema, label: labelSchema };

export const publicationChecklistItemSchema = z.discriminatedUnion('rule', [
  /** The fact has a verified value in the pack. */
  z.strictObject({ ...checklistCommon, rule: z.literal('fact_present'), fact: keySchema }),
  /** Every staged image in the pack carries the "Virtually staged" label. */
  z.strictObject({ ...checklistCommon, rule: z.literal('staged_images_labeled') }),
  /** No unresolved claim-audit flag of this category remains. */
  z.strictObject({
    ...checklistCommon,
    rule: z.literal('no_flagged_phrasing'),
    category: phrasingCategorySchema,
  }),
]);
export type PublicationChecklistItem = z.infer<typeof publicationChecklistItemSchema>;

export const marketProfileSchema = z
  .strictObject({
    id: definitionIdSchema,
    version: definitionVersionSchema,
    name: labelSchema,
    source_languages: z.array(languageCodeSchema).min(1),
    output_languages: z.array(languageCodeSchema).min(1),
    default_output_language: languageCodeSchema,
    units: z.strictObject({ area: areaUnitSchema, volume: volumeUnitSchema.optional() }),
    /** ISO 4217 code for `money` facts. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code such as "EUR"')
      .optional(),
    area_bases: z.array(areaBasisSchema).min(1),
    facts: z.array(marketFactSchema).min(1),
    publication_checklist: z.array(publicationChecklistItemSchema),
    flagged_phrasing: z.array(phrasingCategorySchema).min(1),
    /**
     * Domain and room terms in the source languages that bias Voice Transcribe (intake), e.g.
     * `meterkast`, `vlizotrap`. Fact labels contribute their parenthesised local terms too.
     */
    transcription_keywords: z
      .array(transcriptionKeywordSchema)
      .max(TRANSCRIPTION_KEYWORD_LIMITS.maxKeywords)
      .default([]),
  })
  .superRefine((market, ctx) => {
    checkUnique(ctx, market.source_languages, (i) => ['source_languages', i], 'language');
    checkUnique(ctx, market.output_languages, (i) => ['output_languages', i], 'language');
    if (!market.output_languages.includes(market.default_output_language)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default_output_language'],
        message: `Default output language "${market.default_output_language}" is not listed in output_languages`,
      });
    }

    const bases = market.area_bases.map((basis) => basis.id);
    checkUnique(ctx, bases, (i) => ['area_bases', i, 'id'], 'area basis');

    const factKeys = market.facts.map((fact) => fact.key);
    checkUnique(ctx, factKeys, (i) => ['facts', i, 'key'], 'fact key');

    market.facts.forEach((fact, i) => {
      switch (fact.type) {
        case 'enum':
          checkUnique(ctx, fact.values, (v) => ['facts', i, 'values', v], 'enum value');
          break;
        case 'area':
          if (!bases.includes(fact.basis)) {
            ctx.addIssue({
              code: 'custom',
              path: ['facts', i, 'basis'],
              message: `Area basis "${fact.basis}" is not listed in area_bases`,
            });
          }
          break;
        case 'volume':
          if (market.units.volume === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['facts', i, 'type'],
              message: 'A volume fact needs units.volume',
            });
          }
          break;
        case 'integer':
          if (fact.min !== undefined && fact.max !== undefined && fact.min > fact.max) {
            ctx.addIssue({ code: 'custom', path: ['facts', i, 'min'], message: 'min exceeds max' });
          }
          break;
        case 'money':
          if (market.currency === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['facts', i, 'type'],
              message: 'A money fact needs a profile currency',
            });
          }
          break;
        case 'boolean':
          break;
        default: {
          const unreachable: never = fact;
          throw new Error(`Unhandled fact type: ${JSON.stringify(unreachable)}`);
        }
      }
    });

    checkUnique(
      ctx,
      market.publication_checklist.map((item) => item.id),
      (i) => ['publication_checklist', i, 'id'],
      'checklist ID',
    );
    market.publication_checklist.forEach((item, i) => {
      if (item.rule === 'fact_present' && !factKeys.includes(item.fact)) {
        ctx.addIssue({
          code: 'custom',
          path: ['publication_checklist', i, 'fact'],
          message: `Checklist rule references unknown fact "${item.fact}"`,
        });
      }
      if (item.rule === 'no_flagged_phrasing' && !market.flagged_phrasing.includes(item.category)) {
        ctx.addIssue({
          code: 'custom',
          path: ['publication_checklist', i, 'category'],
          message: `Phrasing category "${item.category}" is not listed in flagged_phrasing`,
        });
      }
    });

    checkUnique(ctx, market.flagged_phrasing, (i) => ['flagged_phrasing', i], 'phrasing category');
    checkUnique(
      ctx,
      market.transcription_keywords.map((term) => term.normalize('NFC').toLowerCase()),
      (i) => ['transcription_keywords', i],
      'transcription keyword',
    );
  });
export type MarketProfile = z.infer<typeof marketProfileSchema>;

/** The top-level shape of a market profile file. */
export const marketProfileFileSchema = z.strictObject({ market: marketProfileSchema });
