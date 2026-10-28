import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadDefinitions } from '../../definitions/loader.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { NonRetryableStepError, type StepConfig } from '../../runs/steps.ts';
import { BudgetExceededError } from '../../usage/budget.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { buildVerificationRequests, verifyWithFallback } from './call.ts';
import type { VerificationStepInput } from './step-schema.ts';
import { recordedVerifierStep } from './testing.ts';

// The verifier's fallback policy against a stubbed fetch (no network, no fixtures), the same
// policy as reconciliation: Wonder failures the model is responsible for hand over to Spark
// once; budget errors never do; a truncated fallback fails the run.

const INPUT: VerificationStepInput = {
  language: { code: 'en', name: 'English' },
  market: { id: 'nl', currency: 'EUR', units: { area: 'm2', volume: 'm3' }, areaBases: [] },
  rubric: [{ category: 'claim_support', rule: 'Say only what the cited facts say.' }],
  facts: [
    {
      id: 'VF01',
      key: 'energy_label',
      label: null,
      value: 'B',
      unit: null,
      basis: null,
      presence: false,
      seenIn: [],
    },
  ],
  copy: [
    {
      variant: 'portal',
      segments: [
        { id: 'P01', paragraph: 0, text: 'It has energy label B.', factIds: ['VF01'], audit: true },
      ],
    },
  ],
};
const REQUEST = { input: INPUT, auditIds: ['P01'], categories: ['claim_support'] as const };

const USAGE = {
  input_tokens: 3000,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 700,
  output_tokens_details: { reasoning_tokens: 600 },
  total_tokens: 3700,
};

function responseBody(model: string, text: string, incomplete = false) {
  return {
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
  };
}

type Reply = { kind: 'json'; body: unknown } | { kind: 'status'; status: number };
const FLAGS = {
  flags: [{ segment: 'P01', category: 'claim_support', problem: 'p', suggestion: null }],
};
const ok = (model: string): Reply => ({
  kind: 'json',
  body: responseBody(model, JSON.stringify(FLAGS)),
});
const truncated = (model: string): Reply => ({
  kind: 'json',
  body: responseBody(model, '{"flags":[{"segment":"P0', true),
});
const status = (code: number): Reply => ({ kind: 'status', status: code });

const bodySchema = z.object({
  model: z.string(),
  reasoning: z.object({ effort: z.string() }),
  text: z.object({ format: z.object({ name: z.string(), schema: z.unknown() }) }),
});

function stubMeta(route: (model: string) => Reply) {
  const sent: { model: string; effort: string; schema: unknown }[] = [];
  vi.stubGlobal('fetch', (_input: string | URL | Request, init?: RequestInit) => {
    const body = bodySchema.parse(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    sent.push({
      model: body.model,
      effort: body.reasoning.effort,
      schema: body.text.format.schema,
    });
    const reply = route(body.model);
    return Promise.resolve(
      reply.kind === 'json'
        ? Response.json(reply.body)
        : Response.json(
            { error: { message: 'stubbed', type: 'server_error' } },
            { status: reply.status },
          ),
    );
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
let step: StepConfig<'verifier'>;

beforeAll(async () => {
  step = recordedVerifierStep(await loadDefinitions());
});

afterEach(() => {
  vi.unstubAllGlobals();
  usage.clear();
});

describe('verification call', () => {
  it('takes model, effort, cap, and fallback from the step and limits the output to audited segments and rubric categories', async () => {
    const { primary, fallback } = buildVerificationRequests(
      { ...step, model: 'muse-spark-1.3', reasoning_effort: 'high', max_output_tokens: 777 },
      REQUEST,
    );
    expect([primary.modelId, primary.reasoningEffort, primary.maxOutputTokens]).toEqual([
      'muse-spark-1.3',
      'high',
      777,
    ]);
    expect([fallback?.modelId, fallback?.reasoningEffort]).toEqual(['muse-spark-1.3', 'medium']);
    const { fallback_model: _m, fallback_reasoning_effort: _e, ...noFallback } = step;
    expect(buildVerificationRequests(noFallback, REQUEST).fallback).toBeNull();

    const sent = stubMeta(ok);
    const answer = await verifyWithFallback(
      { clients, meter: passThrough },
      buildVerificationRequests(step, REQUEST),
    );
    expect(answer.output).toEqual(FLAGS);
    expect(answer.modelRun).toEqual({
      model: 'muse-wonder-1.0',
      reasoningEffort: 'low',
      maxOutputTokens: 12000,
      fallbackFrom: null,
    });
    const schema = JSON.stringify(sent[0]?.schema);
    expect(schema).toContain('"enum":["P01"]');
    expect(schema).toContain('"enum":["claim_support"]');
  });

  it('falls back to Spark once when Wonder fails, and records it', async () => {
    const sent = stubMeta((model) => (model === 'muse-wonder-1.0' ? status(503) : ok(model)));
    const failures: string[] = [];
    const answer = await verifyWithFallback(
      { clients, meter: passThrough, onFallback: (failure) => failures.push(failure) },
      buildVerificationRequests(step, REQUEST),
    );
    expect(sent.map((s) => [s.model, s.effort])).toEqual([
      ['muse-wonder-1.0', 'low'],
      ['muse-spark-1.3', 'medium'],
    ]);
    expect(answer.modelRun.fallbackFrom).toEqual({
      model: 'muse-wonder-1.0',
      reasoningEffort: 'low',
      failure: 'APICallError 503',
    });
    expect(failures).toEqual(['APICallError 503']);

    stubMeta((model) => (model === 'muse-wonder-1.0' ? truncated(model) : ok(model)));
    usage.clear();
    const cut = await verifyWithFallback(
      { clients, meter: passThrough },
      buildVerificationRequests(step, REQUEST),
    );
    expect(cut.modelRun.fallbackFrom?.failure).toBe('NoObjectGeneratedError length');
    expect(usage.entries.map((e) => e.modelId)).toEqual(['muse-wonder-1.0', 'muse-spark-1.3']);
  });

  it('never falls back on budget errors; a truncated fallback fails the run', async () => {
    const sent = stubMeta(ok);
    const budget = new BudgetExceededError('run', '1.00', '1.00');
    await expect(
      verifyWithFallback(
        { clients, meter: () => Promise.reject(budget) },
        buildVerificationRequests(step, REQUEST),
      ),
    ).rejects.toBe(budget);
    expect(sent).toEqual([]);

    stubMeta((model) => (model === 'muse-wonder-1.0' ? status(503) : truncated(model)));
    await expect(
      verifyWithFallback({ clients, meter: passThrough }, buildVerificationRequests(step, REQUEST)),
    ).rejects.toBeInstanceOf(NonRetryableStepError);
  });
});
