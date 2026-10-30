import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadDefinitions } from '../../definitions/loader.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { isReplayMiss, REPLAY_MISS_HEADER, REPLAY_MISS_VALUE } from '../../meta/service-errors.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { NonRetryableStepError, type StepConfig } from '../../runs/steps.ts';
import { BudgetExceededError } from '../../usage/budget.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { buildReconciliationRequests, modelFailureClass, reconcileWithFallback } from './call.ts';
import type { ReconciliationInput, ReconciliationStepOutput } from './schema.ts';
import { recordedReconciliationStep } from './testing.ts';

// The fallback policy against a stubbed fetch (no network, no fixtures): which Wonder failures
// hand over to Spark, that the fallback runs once, and what the usage recorder sees. The
// recorded fallback on the real catalog is in reconciliation-fallback.test.ts.

const INPUT: ReconciliationInput = {
  property: { market: 'nl', sourceLanguage: 'nl, en' },
  form: [{ id: 'F.living_area', field: 'living_area', value: 92, unit: 'm2', basis: 'NEN2580' }],
  transcript: [],
  candidates: [],
  photos: [],
  inventory: [],
};

const ANSWER: ReconciliationStepOutput = { verifiedFacts: [], conflicts: [], rejected: [] };
const USAGE = {
  input_tokens: 5000,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 3000,
  output_tokens_details: { reasoning_tokens: 1000 },
  total_tokens: 8000,
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

type Reply =
  | { kind: 'json'; body: unknown }
  | { kind: 'status'; status: number; headers?: Record<string, string> };
const ok = (model: string): Reply => ({
  kind: 'json',
  body: responseBody(model, JSON.stringify(ANSWER)),
});
const truncated = (model: string): Reply => ({
  kind: 'json',
  body: responseBody(model, '{"verifiedFacts":[{"key":"other:sto', true),
});
const status = (code: number): Reply => ({ kind: 'status', status: code });

const bodySchema = z.object({ model: z.string(), reasoning: z.object({ effort: z.string() }) });

function stubMeta(route: (model: string) => Reply): { model: string; effort: string }[] {
  const sent: { model: string; effort: string }[] = [];
  vi.stubGlobal('fetch', (_input: string | URL | Request, init?: RequestInit) => {
    // Like the real fetch: an aborted signal rejects before anything is sent.
    if (init?.signal?.aborted === true) {
      return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
    }
    const body = bodySchema.parse(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    sent.push({ model: body.model, effort: body.reasoning.effort });
    const reply = route(body.model);
    return Promise.resolve(
      reply.kind === 'json'
        ? Response.json(reply.body)
        : Response.json(
            { error: { message: 'stubbed', type: 'server_error' } },
            { status: reply.status, headers: reply.headers ?? {} },
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
let step: StepConfig<'reconciler'>;

beforeAll(async () => {
  step = recordedReconciliationStep(await loadDefinitions());
});

afterEach(() => {
  vi.unstubAllGlobals();
  usage.clear();
});

describe('reconciliation fallback', () => {
  it('takes model, effort, cap, and fallback from the step configuration', () => {
    const { primary, fallback } = buildReconciliationRequests(
      {
        ...step,
        model: 'muse-spark-1.3',
        reasoning_effort: 'high',
        max_output_tokens: 777,
        fallback_model: 'muse-wonder-1.0',
        fallback_reasoning_effort: 'minimal',
      },
      INPUT,
    );
    expect([primary.modelId, primary.reasoningEffort, primary.maxOutputTokens]).toEqual([
      'muse-spark-1.3',
      'high',
      777,
    ]);
    expect([fallback?.modelId, fallback?.reasoningEffort, fallback?.maxOutputTokens]).toEqual([
      'muse-wonder-1.0',
      'minimal',
      777,
    ]);
    const { fallback_model: _m, fallback_reasoning_effort: _e, ...noFallback } = step;
    expect(buildReconciliationRequests(noFallback, INPUT).fallback).toBeNull();
  });

  it('uses Wonder when it answers', async () => {
    const sent = stubMeta(ok);
    const answer = await reconcileWithFallback(
      { clients, meter: passThrough },
      buildReconciliationRequests(step, INPUT),
    );
    expect(sent).toEqual([{ model: 'muse-wonder-1.0', effort: 'low' }]);
    expect(answer.modelRun).toEqual({
      model: 'muse-wonder-1.0',
      reasoningEffort: 'low',
      maxOutputTokens: 12000,
      fallbackFrom: null,
    });
  });

  it('falls back to Spark once when Wonder is unavailable, and records which model answered', async () => {
    const sent = stubMeta((model) => (model === 'muse-wonder-1.0' ? status(503) : ok(model)));
    const fallbacks: string[] = [];
    const answer = await reconcileWithFallback(
      { clients, meter: passThrough, onFallback: (failure) => fallbacks.push(failure) },
      buildReconciliationRequests(step, INPUT),
    );
    expect(sent).toEqual([
      { model: 'muse-wonder-1.0', effort: 'low' },
      { model: 'muse-spark-1.3', effort: 'medium' },
    ]);
    expect(answer.modelRun).toEqual({
      model: 'muse-spark-1.3',
      reasoningEffort: 'medium',
      maxOutputTokens: 12000,
      fallbackFrom: {
        model: 'muse-wonder-1.0',
        reasoningEffort: 'low',
        failure: 'APICallError 503',
      },
    });
    expect(fallbacks).toEqual(['APICallError 503']);
    // A failed HTTP call reports no usage: only Spark is billed.
    expect(usage.entries.map((e) => e.modelId)).toEqual(['muse-spark-1.3']);
  });

  it('falls back on a non-retryable rejection and on an unusable (billed) Wonder answer', async () => {
    stubMeta((model) => (model === 'muse-wonder-1.0' ? status(400) : ok(model)));
    const rejected = await reconcileWithFallback(
      { clients, meter: passThrough },
      buildReconciliationRequests(step, INPUT),
    );
    expect(rejected.modelRun.fallbackFrom?.failure).toBe('APICallError 400');

    usage.clear();
    stubMeta((model) => (model === 'muse-wonder-1.0' ? truncated(model) : ok(model)));
    const cut = await reconcileWithFallback(
      { clients, meter: passThrough },
      buildReconciliationRequests(step, INPUT),
    );
    expect(cut.modelRun.fallbackFrom?.failure).toBe('NoObjectGeneratedError length');
    // Both calls were billed, and both reach the usage recorder (and so the ledger).
    expect(usage.entries.map((e) => [e.modelId, e.outputTokens])).toEqual([
      ['muse-wonder-1.0', 3000],
      ['muse-spark-1.3', 3000],
    ]);
  });

  it('does not fall back when the development replay has no recording', async () => {
    // The fallback's request is not recorded either; the step must fail with the replay's reason.
    const sent = stubMeta(() => ({
      kind: 'status',
      status: 404,
      headers: { [REPLAY_MISS_HEADER]: REPLAY_MISS_VALUE },
    }));
    const error: unknown = await reconcileWithFallback(
      { clients, meter: passThrough },
      buildReconciliationRequests(step, INPUT),
    ).catch((e: unknown) => e);
    expect(isReplayMiss(error)).toBe(true);
    expect(modelFailureClass(error)).toBeUndefined();
    expect(sent.map((s) => s.model)).toEqual(['muse-wonder-1.0']);
  });

  it('does not fall back on budget errors or an aborted step', async () => {
    const sent = stubMeta(ok);
    const budget = new BudgetExceededError('run', '0.50', '0.50');
    const refuse = <T>(_modelId: string, _call: () => Promise<T>): Promise<T> =>
      Promise.reject(budget);
    await expect(
      reconcileWithFallback({ clients, meter: refuse }, buildReconciliationRequests(step, INPUT)),
    ).rejects.toBe(budget);
    expect(sent).toEqual([]);

    const controller = new AbortController();
    controller.abort();
    await expect(
      reconcileWithFallback(
        { clients, meter: passThrough, signal: controller.signal },
        buildReconciliationRequests(step, INPUT),
      ),
    ).rejects.toThrow();
    expect(sent.map((s) => s.model)).not.toContain('muse-spark-1.3');
    expect(modelFailureClass(new Error('boom'))).toBeUndefined();
  });

  it('fails the run when the fallback is truncated too, and rethrows without a fallback', async () => {
    stubMeta((model) => (model === 'muse-wonder-1.0' ? status(503) : truncated(model)));
    await expect(
      reconcileWithFallback(
        { clients, meter: passThrough },
        buildReconciliationRequests(step, INPUT),
      ),
    ).rejects.toBeInstanceOf(NonRetryableStepError);

    const sent = stubMeta(() => status(503));
    const { fallback_model: _m, fallback_reasoning_effort: _e, ...noFallback } = step;
    await expect(
      reconcileWithFallback(
        { clients, meter: passThrough },
        buildReconciliationRequests(noFallback, INPUT),
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(sent).toHaveLength(1);
  });
});
