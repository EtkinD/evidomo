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
import type { ClaimFact } from '../claims/validator.ts';
import type { CopyCatalogFact, CopyFactCatalog } from '../creative/catalog.ts';
import {
  buildQaCardsContent,
  buildQaInput,
  buildQaRequests,
  generateQaCards,
  toQaDraft,
  type QaSources,
} from './generate.ts';
import { QA_OUTPUT_NAME } from './prompt.ts';
import type { QaDraft } from './schema.ts';
import { recordedQaStep } from './testing.ts';

// Request building, the fallback policy, and the validator integration against a stubbed fetch
// (no network, no fixtures). The recorded calls are in qa-cards-en.test.ts and qa-cards-nl.test.ts.

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
    key: 'other:balcony',
    label: null,
    value: true,
    unit: null,
    basis: null,
    presence: true,
    seenIn: ['balcony'],
    factIds: [FACT_IDS[1] ?? ''],
  },
];
const CATALOG: CopyFactCatalog = { facts, byId: new Map(facts.map((f) => [f.id, f])) };
const STORED: ClaimFact[] = [
  {
    id: FACT_IDS[0] ?? '',
    key: 'living_area',
    value: 92,
    unit: 'm2',
    status: 'verified',
    assertion: 'stated',
    source: { kind: 'form' },
  },
  {
    id: FACT_IDS[1] ?? '',
    key: 'other:balcony',
    value: 1,
    unit: null,
    status: 'verified',
    assertion: 'stated',
    source: { kind: 'photo_region' },
  },
];

const GOOD: QaDraft = {
  cards: [
    {
      question: 'How large is the living area?',
      answer: [{ text: 'The living area is 92 m², measured to NEN 2580.', factIds: ['VF01'] }],
    },
    {
      question: 'Is there a balcony?',
      answer: [{ text: 'Yes, the photos show a balcony at the home.', factIds: ['VF02'] }],
    },
  ],
};
const WRONG_NUMBER: QaDraft = {
  cards: [
    {
      question: 'How large is the living area?',
      answer: [{ text: 'The living area is about 95 m² in total.', factIds: ['VF01'] }],
    },
  ],
};
const NO_QUESTIONS: QaDraft = {
  cards: [{ question: 'Living area', answer: GOOD.cards[0]?.answer ?? [] }],
};

const USAGE = {
  input_tokens: 2000,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 1500,
  output_tokens_details: { reasoning_tokens: 900 },
  total_tokens: 3500,
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
      strict: z.boolean(),
      schema: z.object({
        properties: z.object({
          cards: z.object({
            items: z.object({
              properties: z.object({
                answer: z.object({
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
let step: StepConfig<'qa_writer'>;

function sources(overrides: Partial<QaSources> = {}): QaSources {
  return {
    market,
    catalog: CATALOG,
    facts: STORED,
    tone: 'Warm.',
    outputLanguage: 'en',
    revision: null,
    ...overrides,
  };
}
const withFallback = (): StepConfig<'qa_writer'> => ({
  ...step,
  fallback_model: 'muse-wonder-1.0',
  fallback_reasoning_effort: 'low',
});

beforeAll(async () => {
  const registry = await loadDefinitions();
  market = registry.getMarket('nl', 1);
  step = recordedQaStep(registry);
});

afterEach(() => {
  vi.unstubAllGlobals();
  usage.clear();
});

describe('Q&A input and requests', () => {
  it('carries the language, the tone, and the catalog facts, without photo context', () => {
    const input = buildQaInput(sources({ outputLanguage: 'nl', tone: ' ' }));
    expect(input.language).toEqual({ code: 'nl', name: 'Dutch' });
    expect(input.tone).toBeNull();
    expect(input.facts.map((f) => f.id)).toEqual(['VF01', 'VF02']);
    expect(Object.keys(input)).not.toContain('photos');
  });

  it('refuses an output language the market does not offer, before any call', () => {
    expect(() => buildQaInput(sources({ outputLanguage: 'de' }))).toThrow(NonRetryableStepError);
  });

  it('takes model, effort, cap, and fallback from the step and constrains cited IDs', async () => {
    const { primary, fallback } = buildQaRequests(
      { ...withFallback(), reasoning_effort: 'medium', max_output_tokens: 555 },
      market,
      buildQaInput(sources()),
    );
    expect(primary).toMatchObject({
      modelId: 'muse-spark-1.3',
      reasoningEffort: 'medium',
      maxOutputTokens: 555,
    });
    expect(fallback).toMatchObject({ modelId: 'muse-wonder-1.0', reasoningEffort: 'low' });
    // The copy's phrasing rules, exclusionary included for this market, and the question rules.
    expect(primary.system).toContain('perfect for young families');
    expect(primary.system).toContain('Never ask whom the property suits');
    expect(primary.system).toContain('contact the agent');

    const sent = stubMeta((model) => reply(model, JSON.stringify(GOOD)));
    await generateQaCards({ clients, meter: passThrough }, { primary, fallback }, CATALOG, 'en');
    expect(sent[0]).toMatchObject({
      model: 'muse-spark-1.3',
      reasoning: { effort: 'medium' },
      max_output_tokens: 555,
    });
    expect(sent[0]?.text.format).toMatchObject({ name: QA_OUTPUT_NAME, strict: true });
    const ids =
      sent[0]?.text.format.schema.properties.cards.items.properties.answer.items.properties.factIds;
    expect(ids?.items.enum).toEqual(['VF01', 'VF02']);
  });
});

describe('Q&A generation', () => {
  it('stores the claim validator report and keeps a failing card for verification', async () => {
    stubMeta((model) => reply(model, JSON.stringify(WRONG_NUMBER)));
    const input = buildQaInput(sources());
    const generated = await generateQaCards(
      { clients, meter: passThrough },
      buildQaRequests(step, market, input),
      CATALOG,
      'en',
    );
    const content = buildQaCardsContent({
      generated,
      catalog: CATALOG,
      facts: STORED,
      input,
      revision: 0,
      previousArtifactId: null,
    });
    expect(content.cards).toHaveLength(1);
    expect(content.validation.result).toBe('fail');
    expect(content.validation.findings.map((f) => [f.variant, f.segmentIndex, f.code])).toEqual([
      ['qa', 0, 'number_not_in_facts'],
      ['qa', 0, 'approximate_number'],
    ]);
    expect(content.modelRun).toEqual({
      model: 'muse-spark-1.3',
      reasoningEffort: 'low',
      maxOutputTokens: 8000,
      fallbackFrom: null,
    });
  });

  it('runs the fallback once when the primary cards fail the structural check', async () => {
    const sent = stubMeta((model) =>
      reply(model, JSON.stringify(model === 'muse-spark-1.3' ? NO_QUESTIONS : GOOD)),
    );
    const onFallback = vi.fn();
    const generated = await generateQaCards(
      { clients, meter: passThrough, onFallback },
      buildQaRequests(withFallback(), market, buildQaInput(sources())),
      CATALOG,
      'en',
    );
    expect(sent.map((b) => b.model)).toEqual(['muse-spark-1.3', 'muse-wonder-1.0']);
    expect(onFallback).toHaveBeenCalledWith('QaOutputError no_cards');
    expect(generated.modelRun.fallbackFrom).toMatchObject({ failure: 'QaOutputError no_cards' });
    expect(generated.qa.cards).toHaveLength(2);
    expect(usage.entries).toHaveLength(2);
  });

  it('passes a structural failure through without a fallback, for the engine to retry once', async () => {
    stubMeta((model) => reply(model, JSON.stringify(NO_QUESTIONS)));
    await expect(
      generateQaCards(
        { clients, meter: passThrough },
        buildQaRequests(step, market, buildQaInput(sources())),
        CATALOG,
        'en',
      ),
    ).rejects.toMatchObject({ name: 'QaOutputError', problem: 'no_cards' });
  });

  it('fails the run on a truncated answer instead of paying for it again', async () => {
    stubMeta((model) => reply(model, '{"cards":[{"quest', true));
    const failure = generateQaCards(
      { clients, meter: passThrough },
      buildQaRequests(withFallback(), market, buildQaInput(sources())),
      CATALOG,
      'en',
    );
    // The primary's truncation is a model failure (fallback runs), and the fallback's
    // truncation fails the run.
    await expect(failure).rejects.toBeInstanceOf(NonRetryableStepError);
    await expect(failure).rejects.toThrow('max_output_tokens (8000)');
  });

  it('never falls back on budget errors', async () => {
    const sent = stubMeta((model) => reply(model, JSON.stringify(GOOD)));
    const refuse = (): Promise<never> =>
      Promise.reject(new BudgetExceededError('run', '1.00', '1.00'));
    await expect(
      generateQaCards(
        { clients, meter: refuse },
        buildQaRequests(withFallback(), market, buildQaInput(sources())),
        CATALOG,
        'en',
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(sent).toEqual([]);
  });
});

describe('Q&A revision drafts (P3-06)', () => {
  it('turns stored cards back into the model draft and sends them with their flags', async () => {
    stubMeta((model) => reply(model, JSON.stringify(GOOD)));
    const input = buildQaInput(sources());
    const content = buildQaCardsContent({
      generated: await generateQaCards(
        { clients, meter: passThrough },
        buildQaRequests(step, market, input),
        CATALOG,
        'en',
      ),
      catalog: CATALOG,
      facts: STORED,
      input,
      revision: 0,
      previousArtifactId: null,
    });
    expect(toQaDraft(content)).toEqual(GOOD);
    const revision = {
      draft: toQaDraft(content),
      flags: [{ card: 1, segment: 0, problem: '"at the home" is not stated.' }],
    };
    const revised = buildQaRequests(step, market, buildQaInput(sources({ revision })));
    expect(JSON.parse(revised.primary.prompt)).toMatchObject({ revision });
  });
});
