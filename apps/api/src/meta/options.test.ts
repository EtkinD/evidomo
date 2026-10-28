import { generateText } from 'ai';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMetaClients, META_BASE_URL } from './clients.ts';
import {
  META_REASONING_EFFORTS,
  metaProviderOptions,
  metaReasoningEffortSchema,
  metaResponsesParams,
} from './options.ts';
import { createInMemoryUsageRecorder } from './usage.ts';

// The request body the SDKs serialize is the contract under test, so a local MSW handler
// captures it and answers with a minimal canned response. Nothing reaches the network.
const captured: unknown[] = [];
const cannedResponse = {
  id: 'resp_test',
  object: 'response',
  created_at: 0,
  status: 'completed',
  model: 'muse-spark-1.3',
  output: [
    {
      type: 'message',
      id: 'msg_test',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
  },
};
const server = setupServer(
  http.post(`${META_BASE_URL}/responses`, async ({ request }) => {
    captured.push(await request.json());
    return HttpResponse.json(cannedResponse);
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  captured.length = 0;
});
afterAll(() => {
  server.close();
});

const clients = createMetaClients({
  apiKey: 'test-key',
  usage: createInMemoryUsageRecorder(),
  maxRetries: 0,
});

async function aiSdkRequestBody(
  providerOptions: NonNullable<Parameters<typeof generateText>[0]['providerOptions']>,
): Promise<unknown> {
  await generateText({
    model: clients.languageModel('muse-spark-1.3'),
    prompt: 'x',
    maxOutputTokens: 16,
    providerOptions,
    ...clients.aiSdkCallOptions(),
  });
  expect(captured).toHaveLength(1);
  return captured[0];
}

describe('metaProviderOptions (AI SDK)', () => {
  it.each(META_REASONING_EFFORTS)('sends reasoning.effort "%s" and store:false', async (effort) => {
    const body = await aiSdkRequestBody(metaProviderOptions({ reasoningEffort: effort }));
    expect(body).toMatchObject({ reasoning: { effort }, store: false });
    // reasoningSummary:null suppresses the SDK's default `summary: "detailed"`.
    expect(body).not.toHaveProperty('reasoning.summary');
    // Side effect of store:false on a reasoning model; Meta then returns encrypted reasoning.
    expect(body).toMatchObject({ include: ['reasoning.encrypted_content'] });
  });

  it('sends store:true only when asked', async () => {
    const body = await aiSdkRequestBody(
      metaProviderOptions({ reasoningEffort: 'low', store: true }),
    );
    expect(body).toMatchObject({ reasoning: { effort: 'low' }, store: true });
  });

  it('documents why the helper exists: the SDK drops naive options for Meta model IDs', async () => {
    // Under the provider name `meta`, everything is ignored silently.
    const metaKey = await aiSdkRequestBody({ meta: { reasoningEffort: 'low', store: false } });
    expect(metaKey).not.toHaveProperty('reasoning');
    expect(metaKey).not.toHaveProperty('store');
    captured.length = 0;

    // Under `openai` without forceReasoning, the effort is dropped (muse-* is not an o/gpt-5 ID).
    const openaiKey = await aiSdkRequestBody({ openai: { reasoningEffort: 'low', store: false } });
    expect(openaiKey).not.toHaveProperty('reasoning');
    expect(openaiKey).toMatchObject({ store: false });
  });
});

describe('metaResponsesParams (openai SDK)', () => {
  it('passes the effort and store:false through responses.create', async () => {
    await clients.openai.responses.create({
      model: 'muse-spark-1.3',
      input: 'x',
      max_output_tokens: 16,
      ...metaResponsesParams({ reasoningEffort: 'max' }),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ reasoning: { effort: 'max' }, store: false });
  });
});

describe('metaReasoningEffortSchema', () => {
  it('accepts the efforts Meta accepts and rejects the rest', () => {
    for (const effort of META_REASONING_EFFORTS) {
      expect(metaReasoningEffortSchema.parse(effort)).toBe(effort);
    }
    // `none` is valid in OpenAI's enum but Meta answers 400 for muse-spark-1.3.
    expect(metaReasoningEffortSchema.safeParse('none').success).toBe(false);
    expect(metaReasoningEffortSchema.safeParse('extreme').success).toBe(false);
  });
});
