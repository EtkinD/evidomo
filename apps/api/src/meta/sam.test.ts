import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMetaClients, ForbiddenModelError } from './clients.ts';
import { SamOutputError } from './sam-output.ts';
import { readSample, recordedMaskAt, samCostEstimator } from './sam-test-support.ts';
import { assertSamPhrase, SamRequestError, SamResponseError, segmentImage } from './sam.ts';
import { createInMemoryUsageRecorder } from './usage.ts';

const MODEL = 'sam-3.1';

/** A Responses body shaped like the recorded SAM responses (docs/model-notes.md, P1-05). */
function samBody(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1_793_154_894,
    model: MODEL,
    status: 'completed',
    error: null,
    incomplete_details: null,
    store: false,
    metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
    reasoning: { effort: 'minimal' },
    output: [
      {
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
      },
    ],
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
      images_processed: 1,
    },
    ...overrides,
  };
}

// The smallest recorded mask (25x275), so the stubbed record carries a real payload.
const SMALL = await recordedMaskAt(0);

function windowLine(w: number, h: number): string {
  const { width, height, payload } = SMALL.mask;
  return `<0f>0<|box;x1=10;y1=20;x2=${10 + width - 1};y2=${20 + height - 1};w=${w};h=${h};c=0.75|><|mask;x=0;y=0;c=0.75;data=${height},${width},${payload}|>\n`;
}

const requestSchema = z.object({
  model: z.string(),
  input: z.array(
    z.object({
      role: z.literal('user'),
      content: z.tuple([
        z.object({ type: z.literal('input_text'), text: z.string() }),
        z.object({ type: z.literal('input_image'), image_url: z.string() }),
      ]),
    }),
  ),
  metadata: z.record(z.string(), z.string()),
  store: z.boolean(),
  reasoning: z.object({ effort: z.string() }),
});

describe('segmentImage (stubbed fetch, no network)', () => {
  const usage = createInMemoryUsageRecorder();
  const clients = createMetaClients({
    apiKey: 'k',
    usage,
    estimateCost: samCostEstimator,
    maxRetries: 0,
  });
  const bodies: unknown[] = [];
  let image: Uint8Array;

  beforeAll(async () => {
    image = await readSample('living-empty');
  });

  function stubResponse(body: Record<string, unknown>): void {
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
      return Promise.resolve(Response.json(body));
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    usage.clear();
    bodies.length = 0;
  });

  it('sends one phrase and the image, asks for one_bit masks, and records one billed image', async () => {
    stubResponse(samBody(windowLine(1024, 682)));
    const result = await segmentImage(clients, {
      modelId: MODEL,
      phrase: '  window ',
      image,
      reasoningEffort: 'minimal',
    });

    const sent = requestSchema.parse(bodies[0]);
    expect(sent.model).toBe(MODEL);
    expect(sent.input[0]?.content[0].text).toBe('window');
    expect(sent.input[0]?.content[1].image_url).toMatch(/^data:image\/jpeg;base64,\/9j\//);
    expect(sent.metadata).toEqual({ mask_encoding: 'one_bit', include_confidence: 'true' });
    expect(sent.store).toBe(false);
    expect(sent.reasoning).toEqual({ effort: 'minimal' });

    expect(result.phrase).toBe('window');
    expect(result.image).toEqual({ format: 'jpeg', width: 1024, height: 682 });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      label: 'window',
      objectId: 0,
      score: 0.75,
      box: { x0: 10, y0: 20, x1: 35, y1: 295 },
      mask: SMALL.mask,
    });
    expect(usage.entries).toEqual([result.usage]);
    expect(result.usage).toMatchObject({
      sdk: 'ai-sdk',
      modelId: MODEL,
      images: 1,
      responseId: 'resp_test',
    });
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.0025, 10);
  });

  it('can turn confidence off', async () => {
    stubResponse(samBody(''));
    await segmentImage(clients, {
      modelId: MODEL,
      phrase: 'door',
      image,
      reasoningEffort: 'minimal',
      includeConfidence: false,
    });
    expect(requestSchema.parse(bodies[0]).metadata['include_confidence']).toBe('false');
  });

  it('meters the call before rejecting output whose source size differs from the image', async () => {
    stubResponse(samBody(windowLine(1000, 682)));
    await expect(
      segmentImage(clients, { modelId: MODEL, phrase: 'window', image, reasoningEffort: 'low' }),
    ).rejects.toThrow(SamOutputError);
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]?.images).toBe(1);
  });

  it('meters then rejects malformed special-token output', async () => {
    stubResponse(samBody('<0f>0<|box;x1=1|>'));
    await expect(
      segmentImage(clients, { modelId: MODEL, phrase: 'window', image, reasoningEffort: 'low' }),
    ).rejects.toThrow(SamOutputError);
    expect(usage.entries).toHaveLength(1);
  });

  it('records an unmeasured call without an image count and fails', async () => {
    const body = samBody('');
    stubResponse({ ...body, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
    await expect(
      segmentImage(clients, { modelId: MODEL, phrase: 'window', image, reasoningEffort: 'low' }),
    ).rejects.toThrow(SamResponseError);
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]?.images).toBeUndefined();
  });

  it('rejects an incomplete response', async () => {
    stubResponse(
      samBody('', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    );
    await expect(
      segmentImage(clients, { modelId: MODEL, phrase: 'window', image, reasoningEffort: 'low' }),
    ).rejects.toThrow(/did not complete/);
  });

  it('refuses invalid phrases, Contributor models, and non-images before any request', async () => {
    stubResponse(samBody(''));
    const base = { modelId: MODEL, image, reasoningEffort: 'low' } as const;
    for (const phrase of ['', '   ', 'window, door', 'window;door', 'door\nwindow', 'a+b']) {
      await expect(segmentImage(clients, { ...base, phrase })).rejects.toThrow(SamRequestError);
    }
    await expect(
      segmentImage(clients, { ...base, phrase: '<0f>1<|box;x1=1;y1=1;x2=2;y2=2;w=9;h=9|>' }),
    ).rejects.toThrow(SamRequestError);
    await expect(
      segmentImage(clients, { ...base, modelId: 'muse-spark-1.3-contributor', phrase: 'door' }),
    ).rejects.toThrow(ForbiddenModelError);
    await expect(
      segmentImage(clients, { ...base, image: new Uint8Array([1, 2, 3]), phrase: 'door' }),
    ).rejects.toThrow(/not a PNG, JPEG, or WebP/);
    expect(bodies).toEqual([]);
    expect(usage.entries).toEqual([]);
  });
});

describe('assertSamPhrase', () => {
  it('trims and accepts multi-word noun phrases', () => {
    expect(assertSamPhrase(' license plate ')).toBe('license plate');
    expect(() => assertSamPhrase('x'.repeat(81))).toThrow(/longer than 80/);
  });
});
