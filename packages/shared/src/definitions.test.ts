import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { marketProfileSchema, serviceDefinitionSchema, stepModelIds } from './definitions.ts';

// Schema-level checks with plain objects. YAML parsing, file names, and error locations are
// tested with the loader in apps/api/src/definitions.

function validService() {
  return {
    id: 'listing-launch',
    version: 1,
    name: 'Listing launch',
    inputs: [
      { key: 'photos', type: 'images', min: 10, max: 30, required: true },
      { key: 'voice_memo', type: 'audio', max_seconds: 600, required: true },
      {
        key: 'facts',
        type: 'form',
        schema: 'from_market_profile',
        source_of_truth: true,
        required: true,
      },
    ],
    steps: [
      { id: 'intake', agent: 'intake', model: 'muse-voice-transcribe-1.0' } as Record<
        string,
        unknown
      >,
      {
        id: 'reconciliation',
        agent: 'reconciler',
        model: 'muse-wonder-1.0',
        reasoning_effort: 'low',
        max_output_tokens: 12000,
        fallback_model: 'muse-spark-1.3',
        fallback_reasoning_effort: 'medium',
        gate_after: 'fact_conflicts',
      } as Record<string, unknown>,
      { id: 'export', agent: 'exporter' } as Record<string, unknown>,
    ],
    budget: { max_cost_usd_per_run: '0.50' } as Record<string, unknown>,
  };
}

function validMarket() {
  return {
    id: 'nl',
    version: 1,
    name: 'Netherlands',
    source_languages: ['nl', 'en'],
    output_languages: ['en', 'nl'],
    default_output_language: 'en',
    units: { area: 'm2', volume: 'm3' } as Record<string, unknown>,
    currency: 'EUR' as string | undefined,
    area_bases: [{ id: 'NEN2580', label: 'NEN 2580' }],
    facts: [
      {
        key: 'energy_label',
        label: 'Energy label',
        type: 'enum',
        values: ['A', 'B'],
        required: true,
      } as Record<string, unknown>,
      {
        key: 'living_area',
        label: 'Living area',
        type: 'area',
        basis: 'NEN2580',
        required: true,
      } as Record<string, unknown>,
      { key: 'volume', label: 'Volume', type: 'volume' } as Record<string, unknown>,
      { key: 'vve', label: 'VvE contribution', type: 'money' } as Record<string, unknown>,
    ],
    publication_checklist: [
      {
        id: 'energy_label_shown',
        label: 'Label shown',
        rule: 'fact_present',
        fact: 'energy_label',
      },
      { id: 'staging_disclosed', label: 'Staging disclosed', rule: 'staged_images_labeled' },
    ] as Record<string, unknown>[],
    flagged_phrasing: ['exclusionary', 'investment_promise'],
  };
}

function messages(result: z.ZodSafeParseResult<unknown>): string[] {
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('serviceDefinitionSchema', () => {
  it('accepts a valid definition and defaults nothing silently', () => {
    const parsed = serviceDefinitionSchema.parse(validService());
    expect(parsed.budget.max_cost_usd_per_run).toBe('0.50');
    expect(parsed.steps.map((step) => step.agent)).toEqual(['intake', 'reconciler', 'exporter']);
  });

  it('rejects an unquoted (float) budget instead of coercing it', () => {
    const service = validService();
    service.budget.max_cost_usd_per_run = 0.5;
    expect(messages(serviceDefinitionSchema.safeParse(service))).toEqual([
      'budget.max_cost_usd_per_run: Expected a quoted decimal string such as "0.50" (an unquoted YAML number is a float)',
    ]);
  });

  it('rejects a zero budget', () => {
    const service = validService();
    service.budget.max_cost_usd_per_run = '0';
    expect(messages(serviceDefinitionSchema.safeParse(service))).toEqual([
      'budget.max_cost_usd_per_run: The run budget must be greater than zero',
    ]);
  });

  it('requires reasoning_effort and max_output_tokens on language-model steps', () => {
    const service = validService();
    delete service.steps[1]?.reasoning_effort;
    delete service.steps[1]?.max_output_tokens;
    const result = messages(serviceDefinitionSchema.safeParse(service));
    expect(result).toHaveLength(2);
    expect(result[0]).toMatch(/^steps\.1\.reasoning_effort: /);
    expect(result[1]).toMatch(/^steps\.1\.max_output_tokens: /);
  });

  it('requires fallback_reasoning_effort exactly when fallback_model is set', () => {
    const missing = validService();
    delete missing.steps[1]?.fallback_reasoning_effort;
    expect(messages(serviceDefinitionSchema.safeParse(missing))).toEqual([
      'steps.1.fallback_reasoning_effort: fallback_reasoning_effort is required when fallback_model is set',
    ]);

    const orphan = validService();
    delete orphan.steps[1]?.fallback_model;
    expect(messages(serviceDefinitionSchema.safeParse(orphan))).toEqual([
      'steps.1.fallback_reasoning_effort: fallback_reasoning_effort is only allowed together with fallback_model',
    ]);
  });

  it('rejects a fallback equal to the primary model', () => {
    const service = validService();
    if (service.steps[1]) service.steps[1].fallback_model = 'muse-wonder-1.0';
    expect(messages(serviceDefinitionSchema.safeParse(service))).toEqual([
      'steps.1.fallback_model: fallback_model must differ from model',
    ]);
  });

  it('rejects a reasoning effort on a model that is not billed per token', () => {
    const service = validService();
    if (service.steps[1]) service.steps[1].model = 'sam-3.1';
    expect(messages(serviceDefinitionSchema.safeParse(service))).toEqual([
      'steps.1.model: Model "sam-3.1" is billed per images, not per token, and cannot take a reasoning_effort',
    ]);
  });

  it('rejects contributor-mode model IDs', () => {
    const service = validService();
    if (service.steps[0]) service.steps[0].model = 'muse-voice-transcribe-1.0-contributor';
    // It is also unpriced; both issues are reported.
    expect(messages(serviceDefinitionSchema.safeParse(service))).toContain(
      'steps.0.model: Contributor-mode model IDs are forbidden (Standard mode only)',
    );
  });

  it('rejects unknown gates and a gate used twice', () => {
    const unknown = validService();
    if (unknown.steps[1]) unknown.steps[1].gate_after = 'final_review';
    expect(messages(serviceDefinitionSchema.safeParse(unknown))[0]).toMatch(
      /^steps\.1\.gate_after: Invalid option: expected one of "fact_conflicts"\|"claim_audit"$/,
    );

    const twice = validService();
    if (twice.steps[2]) twice.steps[2].gate_after = 'fact_conflicts';
    expect(messages(serviceDefinitionSchema.safeParse(twice))).toEqual([
      'steps.2.gate_after: Duplicate gate "fact_conflicts"',
    ]);
  });

  it('rejects unknown agents and keys that do not belong to the agent', () => {
    const agent = validService();
    if (agent.steps[2]) agent.steps[2].agent = 'publisher';
    expect(serviceDefinitionSchema.safeParse(agent).success).toBe(false);

    const key = validService();
    if (key.steps[2]) key.steps[2].max_revision_loops = 2;
    expect(messages(serviceDefinitionSchema.safeParse(key))).toEqual([
      'steps.2: Unrecognized key: "max_revision_loops"',
    ]);
  });

  it('rejects duplicate input keys and audio longer than Voice Transcribe accepts', () => {
    const service = validService();
    if (service.inputs[1]) {
      service.inputs[1].key = 'photos';
      service.inputs[1].max_seconds = 601;
    }
    const result = messages(serviceDefinitionSchema.safeParse(service));
    expect(result).toHaveLength(2);
    expect(result[0]).toMatch(/^inputs\.1\.max_seconds: Too big/);
    expect(result[1]).toBe('inputs.1.key: Duplicate input key "photos"');
  });

  it('lists every model a step names', () => {
    const parsed = serviceDefinitionSchema.parse(validService());
    expect(parsed.steps.map(stepModelIds)).toEqual([
      [{ field: 'model', modelId: 'muse-voice-transcribe-1.0' }],
      [
        { field: 'model', modelId: 'muse-wonder-1.0' },
        { field: 'fallback_model', modelId: 'muse-spark-1.3' },
      ],
      [],
    ]);
  });
});

describe('marketProfileSchema', () => {
  it('accepts a valid profile and defaults required to false', () => {
    const parsed = marketProfileSchema.parse(validMarket());
    expect(parsed.facts.find((fact) => fact.key === 'volume')?.required).toBe(false);
  });

  it('rejects a default output language that is not offered or not a language', () => {
    const notOffered = validMarket();
    notOffered.default_output_language = 'tr';
    expect(messages(marketProfileSchema.safeParse(notOffered))).toEqual([
      'default_output_language: Default output language "tr" is not listed in output_languages',
    ]);

    const unknown = validMarket();
    unknown.output_languages = ['en', 'xx'];
    expect(messages(marketProfileSchema.safeParse(unknown))).toEqual([
      'output_languages.1: Unknown ISO 639-1 language code',
    ]);
  });

  it('rejects duplicate fact keys', () => {
    const market = validMarket();
    if (market.facts[2]) market.facts[2].key = 'energy_label';
    expect(messages(marketProfileSchema.safeParse(market))).toEqual([
      'facts.2.key: Duplicate fact key "energy_label"',
    ]);
  });

  it('requires area facts to carry a basis listed in area_bases', () => {
    const unlisted = validMarket();
    if (unlisted.facts[1]) unlisted.facts[1].basis = 'gross';
    expect(messages(marketProfileSchema.safeParse(unlisted))).toEqual([
      'facts.1.basis: Area basis "gross" is not listed in area_bases',
    ]);

    const missing = validMarket();
    delete missing.facts[1]?.basis;
    expect(messages(marketProfileSchema.safeParse(missing))[0]).toMatch(/^facts\.1\.basis: /);
  });

  it('rejects checklist rules that reference unknown facts or unlisted phrasing categories', () => {
    const market = validMarket();
    if (market.publication_checklist[0]) market.publication_checklist[0].fact = 'energy_rating';
    market.publication_checklist.push({
      id: 'no_superlatives',
      label: 'No superlatives',
      rule: 'no_flagged_phrasing',
      category: 'unverifiable_superlative',
    });
    expect(messages(marketProfileSchema.safeParse(market))).toEqual([
      'publication_checklist.0.fact: Checklist rule references unknown fact "energy_rating"',
      'publication_checklist.2.category: Phrasing category "unverifiable_superlative" is not listed in flagged_phrasing',
    ]);
  });

  it('requires a currency for money facts and a volume unit for volume facts', () => {
    const market = validMarket();
    market.currency = undefined;
    delete market.units.volume;
    expect(messages(marketProfileSchema.safeParse(market))).toEqual([
      'facts.2.type: A volume fact needs units.volume',
      'facts.3.type: A money fact needs a profile currency',
    ]);
  });

  it('rejects duplicate enum values', () => {
    const market = validMarket();
    if (market.facts[0]) market.facts[0].values = ['A', 'B', 'A'];
    expect(messages(marketProfileSchema.safeParse(market))).toEqual([
      'facts.0.values.2: Duplicate enum value "A"',
    ]);
  });
});
