import { randomUUID } from 'node:crypto';
import type { MarketProfile } from '@evidomo/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadDefinitions } from '../../definitions/loader.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { NonRetryableStepError, type StepConfig } from '../../runs/steps.ts';
import { BudgetExceededError } from '../../usage/budget.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import type { CopyCatalogFact, CopyFactCatalog } from './catalog.ts';
import {
  buildCopyInput,
  buildCopyRequests,
  buildListingCopyContent,
  generateListingCopy,
  toCopyDraft,
  type CopySources,
} from './generate.ts';
import { COPY_OUTPUT_NAME } from './prompt.ts';
import type { CopyDraft } from './schema.ts';
import { recordedCopyStep } from './testing.ts';

// Request building and the fallback policy against a stubbed fetch (no network, no fixtures).
// The recorded calls are in creative-copy-en.test.ts and creative-copy-nl.test.ts.

const FACT_IDS = [randomUUID(), randomUUID()];
const facts: CopyCatalogFact[] = [
  {
    id: 'VF01',
    key: 'living_area',
    label: 'Living area (woonoppervlakte)',
    value: 92,
    unit: 'm2',
    basis: 'NEN2580',
    presence: false,
    seenIn: [],
    factIds: [FACT_IDS[0] ?? ''],
  },
  {
    id: 'VF02',
    key: 'other:window',
    label: null,
    value: true,
    unit: null,
    basis: null,
    presence: true,
    seenIn: ['living_room'],
    factIds: [FACT_IDS[1] ?? ''],
  },
];
const CATALOG: CopyFactCatalog = { facts, byId: new Map(facts.map((f) => [f.id, f])) };

const GOOD: CopyDraft = {
  portal: {
    paragraphs: [
      {
        segments: [
          { text: 'This apartment offers 92 m² of living space,', factIds: ['VF01'] },
          {
            text: 'and the living room has windows on the street side of the home.',
            factIds: ['VF02'],
          },
        ],
      },
    ],
  },
  social: {
    segments: [
      {
        text: 'A bright home with 92 m² and windows in the living room.',
        factIds: ['VF01', 'VF02'],
      },
    ],
  },
};
const DUTCH: CopyDraft = {
  portal: {
    paragraphs: [
      {
        segments: [
          {
            text: 'Dit appartement heeft een woonoppervlakte van 92 m² en het is licht.',
            factIds: ['VF01'],
          },
        ],
      },
    ],
  },
  social: {
    segments: [{ text: 'Een woning van 92 m² met ramen in de woonkamer.', factIds: ['VF01'] }],
  },
};

const USAGE = {
  input_tokens: 4000,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 6000,
  output_tokens_details: { reasoning_tokens: 5000 },
  total_tokens: 10000,
};
function reply(model: string, text: string, incomplete = false): Response {
  return Response.json({
    id: `resp_${model}`,
    object: 'response',
    created_at: 1_793_154_894,
    model,
    status: incomplete ? 'incomplete' : 'completed',
    error: null,
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    store: false,
    output: [
      {
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        status: incomplete ? 'incomplete' : 'completed',
        content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
      },
    ],
    usage: USAGE,
  });
}

const bodySchema = z.object({
  model: z.string(),
  reasoning: z.object({ effort: z.string() }),
  max_output_tokens: z.number(),
  text: z.object({
    format: z.object({
      name: z.string(),
      schema: z.object({
        properties: z.object({
          social: z.object({
            properties: z.object({
              segments: z.object({
                items: z.object({
                  properties: z.object({
                    factIds: z.object({ items: z.object({ enum: z.array(z.string()) }) }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
});
type SentBody = z.infer<typeof bodySchema>;

function stubMeta(route: (model: string) => Response): SentBody[] {
  const sent: SentBody[] = [];
  vi.stubGlobal('fetch', (_input: string | URL | Request, init?: RequestInit) => {
    const body = bodySchema.parse(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    sent.push(body);
    return Promise.resolve(route(body.model));
  });
  return sent;
}

const usage = createInMemoryUsageRecorder();
const clients = createMetaClients({
  apiKey: 'k',
  usage,
  estimateCost: createPriceTableCostEstimator(),
  maxRetries: 0,
});
const passThrough = async <T>(_modelId: string, call: () => Promise<T>): Promise<T> => call();
let market: MarketProfile;
let step: StepConfig<'creative'>;

function sources(overrides: Partial<CopySources> = {}): CopySources {
  return {
    market,
    catalog: CATALOG,
    photos: { cover: 'living_room', rooms: ['living_room'] },
    tone: 'Warm.',
    outputLanguage: 'en',
    revision: null,
    ...overrides,
  };
}
const withFallback = (): StepConfig<'creative'> => ({
  ...step,
  fallback_model: 'muse-wonder-1.0',
  fallback_reasoning_effort: 'low',
});

beforeAll(async () => {
  const registry = await loadDefinitions();
  market = registry.getMarket('nl', 1);
  step = recordedCopyStep(registry);
});

afterEach(() => {
  vi.unstubAllGlobals();
  usage.clear();
});

describe('copy input', () => {
  it('carries the output language, the tone (or null), and the catalog facts', () => {
    const input = buildCopyInput(sources({ outputLanguage: 'nl', tone: '   ' }));
    expect(input.language).toEqual({ code: 'nl', name: 'Dutch' });
    expect(input.tone).toBeNull();
    expect(input.facts.map((f) => f.id)).toEqual(['VF01', 'VF02']);
    expect(input.revision).toBeNull();
  });

  it('refuses an output language the market does not offer', () => {
    expect(() => buildCopyInput(sources({ outputLanguage: 'de' }))).toThrow(NonRetryableStepError);
  });
});

describe('copy requests', () => {
  it('takes model, effort, cap, and fallback from the step and constrains cited IDs', async () => {
    const { primary, fallback } = buildCopyRequests(
      { ...withFallback(), reasoning_effort: 'high', max_output_tokens: 777 },
      market,
      buildCopyInput(sources()),
    );
    expect(primary).toMatchObject({
      modelId: 'muse-spark-1.3',
      reasoningEffort: 'high',
      maxOutputTokens: 777,
    });
    expect(fallback).toMatchObject({
      modelId: 'muse-wonder-1.0',
      reasoningEffort: 'low',
      maxOutputTokens: 777,
    });
    expect(primary.system).toContain('perfect for young families');

    const sent = stubMeta((model) => reply(model, JSON.stringify(GOOD)));
    await generateListingCopy(
      { clients, meter: passThrough },
      { primary, fallback },
      CATALOG,
      'en',
    );
    expect(sent[0]).toMatchObject({
      model: 'muse-spark-1.3',
      reasoning: { effort: 'high' },
      max_output_tokens: 777,
    });
    expect(sent[0]?.text.format.name).toBe(COPY_OUTPUT_NAME);
    const ids =
      sent[0]?.text.format.schema.properties.social.properties.segments.items.properties.factIds;
    expect(ids?.items.enum).toEqual(['VF01', 'VF02']);
  });
});

describe('copy generation', () => {
  it('returns checked copy citing stored fact IDs, with the model run', async () => {
    stubMeta((model) => reply(model, JSON.stringify(GOOD)));
    const requests = buildCopyRequests(step, market, buildCopyInput(sources()));
    const generated = await generateListingCopy(
      { clients, meter: passThrough },
      requests,
      CATALOG,
      'en',
    );
    expect(generated.modelRun).toEqual({
      model: 'muse-spark-1.3',
      reasoningEffort: 'medium',
      maxOutputTokens: 16000,
      fallbackFrom: null,
    });
    expect(generated.copy.variants[0]?.segments[1]?.factIds).toEqual([FACT_IDS[1]]);
    expect(usage.entries).toHaveLength(1);
  });

  it('runs the fallback once when the primary copy fails the structural check', async () => {
    const sent = stubMeta((model) =>
      reply(model, JSON.stringify(model === 'muse-spark-1.3' ? DUTCH : GOOD)),
    );
    const onFallback = vi.fn();
    const requests = buildCopyRequests(withFallback(), market, buildCopyInput(sources()));
    const generated = await generateListingCopy(
      { clients, meter: passThrough, onFallback },
      requests,
      CATALOG,
      'en',
    );
    expect(sent.map((b) => b.model)).toEqual(['muse-spark-1.3', 'muse-wonder-1.0']);
    expect(onFallback).toHaveBeenCalledWith('CopyOutputError wrong_language');
    expect(generated.modelRun.fallbackFrom).toEqual({
      model: 'muse-spark-1.3',
      reasoningEffort: 'medium',
      failure: 'CopyOutputError wrong_language',
    });
    // Both calls were billed.
    expect(usage.entries).toHaveLength(2);
  });

  it('passes a structural failure through without a fallback, for the engine to retry once', async () => {
    stubMeta((model) => reply(model, JSON.stringify(DUTCH)));
    const requests = buildCopyRequests(step, market, buildCopyInput(sources()));
    await expect(
      generateListingCopy({ clients, meter: passThrough }, requests, CATALOG, 'en'),
    ).rejects.toMatchObject({ name: 'CopyOutputError', problem: 'wrong_language' });
  });

  it('fails the run on a truncated answer instead of paying for it again', async () => {
    stubMeta((model) => reply(model, '{"portal":{"paragraphs":[{"segm', true));
    const requests = buildCopyRequests(step, market, buildCopyInput(sources()));
    const failure = generateListingCopy({ clients, meter: passThrough }, requests, CATALOG, 'en');
    await expect(failure).rejects.toBeInstanceOf(NonRetryableStepError);
    await expect(failure).rejects.toThrow('max_output_tokens (16000)');
  });

  it('never falls back on budget errors', async () => {
    const sent = stubMeta((model) => reply(model, JSON.stringify(GOOD)));
    const requests = buildCopyRequests(withFallback(), market, buildCopyInput(sources()));
    const refuse = (): Promise<never> =>
      Promise.reject(new BudgetExceededError('run', '1.00', '1.00'));
    await expect(
      generateListingCopy({ clients, meter: refuse }, requests, CATALOG, 'en'),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(sent).toEqual([]);
  });
});

describe('revision drafts (P3-06)', () => {
  it('turns a stored copy back into the model draft and sends it with its flags', async () => {
    stubMeta((model) => reply(model, JSON.stringify(GOOD)));
    const requests = buildCopyRequests(step, market, buildCopyInput(sources()));
    const generated = await generateListingCopy(
      { clients, meter: passThrough },
      requests,
      CATALOG,
      'en',
    );
    const content = buildListingCopyContent({
      generated,
      catalog: CATALOG,
      input: buildCopyInput(sources()),
      revision: 0,
      previousArtifactId: null,
    });
    expect(toCopyDraft(content)).toEqual(GOOD);

    const revision = {
      draft: toCopyDraft(content),
      flags: [
        { variant: 'social' as const, segment: 0, problem: '"bright" is not supported by a fact.' },
      ],
    };
    const revised = buildCopyRequests(step, market, buildCopyInput(sources({ revision })));
    expect(JSON.parse(revised.primary.prompt)).toMatchObject({ revision });
  });
});
