import { randomUUID } from 'node:crypto';
import { listingCopyContentSchema, type MarketProfile } from '@evidomo/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import type { ClaimFact } from '../claims/validator.ts';
import type { CopyCatalogFact, CopyFactCatalog } from '../creative/catalog.ts';
import { validateCopy, type CopySources } from '../creative/generate.ts';
import { recordedCopyStep } from '../creative/testing.ts';
import { qaCardsFromCopy, recordedQaStep } from '../qa/testing.ts';
import { verifyCopy } from './handler.ts';
import { buildVerificationRubric } from './rubric.ts';
import { recordedVerifierStep } from './testing.ts';

// The revision loop with Q&A cards against a stubbed fetch (no network, no fixtures): a failed
// Q&A revision ends the loop as `revision_failed` at the last audited pass, and every billed
// call (the audit and the failed revision) is metered and recorded.

const FACT = randomUUID();
const catalogFact: CopyCatalogFact = {
  id: 'VF01',
  key: 'living_area',
  label: 'Living area (woonoppervlakte)',
  value: 92,
  unit: 'm2',
  basis: 'NEN2580',
  presence: false,
  seenIn: [],
  factIds: [FACT],
};
const CATALOG: CopyFactCatalog = { facts: [catalogFact], byId: new Map([['VF01', catalogFact]]) };
const STORED: ClaimFact[] = [
  {
    id: FACT,
    key: 'living_area',
    value: 92,
    unit: 'm2',
    status: 'verified',
    assertion: 'stated',
    source: { kind: 'form' },
  },
];
const MODEL_RUN = {
  model: 'muse-spark-1.3',
  reasoningEffort: 'medium',
  maxOutputTokens: 16000,
  fallbackFrom: null,
} as const;

function copyDraft() {
  const segment = (index: number, text: string) => ({
    index,
    paragraph: 0,
    text,
    catalogIds: ['VF01'],
    factIds: [FACT],
  });
  const variants = [
    {
      kind: 'portal' as const,
      languageCheck: 'match' as const,
      segments: [segment(0, 'The apartment has a living area of 92 m².')],
    },
    {
      kind: 'social' as const,
      languageCheck: 'match' as const,
      segments: [segment(1, 'A home with 92 m² of living space.')],
    },
  ];
  return listingCopyContentSchema.parse({
    schemaVersion: 1,
    promptVersion: 1,
    modelRun: MODEL_RUN,
    outputLanguage: 'en',
    tone: null,
    revision: 0,
    previousArtifactId: null,
    catalog: [{ id: 'VF01', factIds: [FACT] }],
    variants,
    repairs: { mergedUncited: 0, droppedUncitedParagraphs: 0, droppedEmpty: 0 },
    counts: { catalogFacts: 1, citedCatalogFacts: 1, segments: 2 },
    validation: validateCopy(variants, STORED, 'en'),
  });
}

const USAGE = {
  input_tokens: 3000,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 1000,
  output_tokens_details: { reasoning_tokens: 800 },
  total_tokens: 4000,
};
function reply(model: string, text: string): Response {
  return Response.json({
    id: `resp_${model}`,
    object: 'response',
    created_at: 1_793_154_894,
    model,
    status: 'completed',
    error: null,
    incomplete_details: null,
    store: false,
    output: [
      {
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
      },
    ],
    usage: USAGE,
  });
}
const bodySchema = z.object({
  model: z.string(),
  text: z.object({ format: z.object({ name: z.string() }) }),
});

let registry: DefinitionRegistry;
let market: MarketProfile;
beforeAll(async () => {
  registry = await loadDefinitions();
  market = registry.getMarket('nl', 1);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Q&A revision inside the verification loop', () => {
  it('ends the loop as revision_failed when the Q&A revision is unusable, with both calls billed', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', (_input: string | URL | Request, init?: RequestInit) => {
      const body = bodySchema.parse(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      sent.push(body.text.format.name);
      if (body.text.format.name === 'claim_audit') {
        return Promise.resolve(
          reply(
            body.model,
            JSON.stringify({
              flags: [
                {
                  segment: 'Q01',
                  category: 'exclusionary',
                  problem: 'The question addresses families.',
                  suggestion: null,
                },
              ],
            }),
          ),
        );
      }
      // The Q&A revision: no card with a valid question, so QaOutputError no_cards.
      return Promise.resolve(
        reply(
          body.model,
          JSON.stringify({
            cards: [
              { question: 'Living area', answer: [{ text: 'It is 92 m².', factIds: ['VF01'] }] },
            ],
          }),
        ),
      );
    });
    const usage = createInMemoryUsageRecorder();
    const clients = createMetaClients({ apiKey: 'k', usage, maxRetries: 0 });
    const metered: string[] = [];
    const draft = copyDraft();
    const qa = qaCardsFromCopy(draft, STORED, [
      { question: 'Is the home suited to a family?', segments: [0] },
    ]);
    const sources: CopySources = {
      market,
      catalog: CATALOG,
      facts: STORED,
      photos: null,
      tone: null,
      outputLanguage: 'en',
      revision: null,
    };
    const copyId = randomUUID();
    const qaId = randomUUID();
    const result = await verifyCopy(
      {
        clients: () => clients,
        meter: (modelId, call) => {
          metered.push(modelId);
          return call();
        },
      },
      {
        step: recordedVerifierStep(registry),
        creativeStep: recordedCopyStep(registry),
        market,
        sources,
        rubric: buildVerificationRubric(market),
        initial: { content: draft, storedId: copyId, provisionalId: copyId },
        qa: {
          step: recordedQaStep(registry),
          initial: { content: qa, storedId: qaId, provisionalId: qaId },
        },
      },
    );

    expect(result.stopReason).toBe('revision_failed');
    expect(result.failure).toBe('QaOutputError no_cards');
    // The last audited pass stands; the unusable revision is not a pass.
    expect(result.passes).toHaveLength(1);
    expect(result.passes[0]?.draft.qa?.storedId).toBe(qaId);
    expect(result.passes[0]?.audit.flags.map((f) => [f.variant, f.category])).toEqual([
      ['qa', 'exclusionary'],
    ]);
    // Copy had no flag, so only the Q&A revision was attempted; both calls were metered and
    // recorded (the failed revision was billed).
    expect(sent).toEqual(['claim_audit', 'qa_cards']);
    expect(metered).toEqual(['muse-wonder-1.0', 'muse-spark-1.3']);
    expect(usage.entries.map((e) => e.modelId)).toEqual(['muse-wonder-1.0', 'muse-spark-1.3']);
  });
});
