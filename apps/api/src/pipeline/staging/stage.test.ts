import { InternalServerError } from 'openai';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMetaClients } from '../../meta/clients.ts';
import { createInMemoryUsageRecorder, createTokenPriceEstimator } from '../../meta/usage.ts';
import { stagingOperation, stagingPrompt } from './operations.ts';
import {
  aspectRatioChange,
  requestedSizeFor,
  runStaging,
  stagePhoto,
  type StagingPhoto,
} from './stage.ts';

// One edit per photo through the tools-off JSON body, photo-level vs. step-level failures
// (stubbed fetch, no network).

const MODEL = 'muse-image-1.0';
const usage = createInMemoryUsageRecorder();
const clients = createMetaClients({
  apiKey: 'k',
  usage,
  estimateCost: createTokenPriceEstimator({ [MODEL]: { usdPerImage: 0.01 } }),
  maxRetries: 0,
});
const metered: string[] = [];
const deps = {
  clients,
  meter: async <T>(modelId: string, call: () => Promise<T>): Promise<T> => {
    metered.push(modelId);
    return call();
  },
};
const settings = { imageModel: MODEL, maxStagedImages: 3 };
const operation = stagingOperation('furnish_living_room');

let photo: StagingPhoto;
let output1920: string;

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#d0c0b0' } })
    .jpeg()
    .toBuffer();
}

type Reply = { status: number; body: unknown };

function stub(...replies: Reply[]): Request[] {
  const requests: Request[] = [];
  let i = 0;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply === undefined) throw new Error('no stubbed reply');
    return Promise.resolve(Response.json(reply.body, { status: reply.status }));
  });
  return requests;
}

const ok = (b64: string): Reply => ({
  status: 200,
  body: { created: 1, data: [{ b64_json: b64 }], output_format: 'jpeg' },
});

beforeAll(async () => {
  const bytes = await jpeg(1024, 682);
  photo = {
    materialId: '0b7f2a0e-5c1d-4d6e-9a51-000000000001',
    bytes: new Uint8Array(bytes),
    mediaType: 'image/jpeg',
    width: 1024,
    height: 682,
  };
  output1920 = (await jpeg(1920, 1280)).toString('base64');
});

afterEach(() => {
  vi.unstubAllGlobals();
  usage.clear();
  metered.length = 0;
});

describe('stagePhoto', () => {
  it('sends the declared operation with the original aspect ratio and returns the re-encoded image', async () => {
    const requests = stub(ok(output1920));
    const outcome = await stagePhoto(deps, settings, photo, operation);

    expect(metered).toEqual([MODEL]);
    const body: unknown = await requests[0]?.json();
    expect(body).toMatchObject({
      model: MODEL,
      prompt: stagingPrompt(operation),
      size: '1024x682',
      output_format: 'jpeg',
      tool_enablement: {
        enable_image_search: false,
        enable_web_search: false,
        enable_shell: false,
      },
    });
    if (!outcome.ok) throw new Error(`expected a staged image, got ${outcome.reason}`);
    expect(outcome.value).toMatchObject({
      materialId: photo.materialId,
      operation,
      prompt: stagingPrompt(operation),
      requestedSize: '1024x682',
      modelOutput: { format: 'jpeg', width: 1920, height: 1280 },
      encoded: { width: 1920, height: 1280 },
    });
    expect(outcome.value.aspectRatioChange).toBeCloseTo(0.001, 3);
    expect(usage.entries).toMatchObject([{ sdk: 'openai', modelId: MODEL, images: 1 }]);
  });

  it.each([
    ['rejected_input', { status: 400, body: { error: { message: 'bad image' } } }],
    ['rejected_input', { status: 422, body: { error: { message: 'unprocessable' } } }],
    ['no_image', { status: 200, body: { created: 1, data: [] } }],
    ['invalid_output', ok(Buffer.from('not an image at all').toString('base64'))],
    ['invalid_output', { status: 200, body: { created: 1 } }],
  ] as const)('records a photo failure (%s) instead of failing the step', async (reason, reply) => {
    stub(reply);
    expect(await stagePhoto(deps, settings, photo, operation)).toEqual({ ok: false, reason });
  });

  it('propagates errors a step retry can fix', async () => {
    stub({ status: 500, body: { error: { message: 'server error' } } });
    await expect(stagePhoto(deps, settings, photo, operation)).rejects.toThrow(InternalServerError);
  });
});

describe('runStaging', () => {
  it('keeps the job order and isolates photo failures', async () => {
    stub(ok(output1920), { status: 400, body: { error: { message: 'bad image' } } });
    const outcomes = await runStaging(deps, settings, [
      { photo, operation },
      { photo: { ...photo, materialId: '0b7f2a0e-5c1d-4d6e-9a51-000000000002' }, operation },
    ]);
    // Concurrent calls: which job got which reply is not fixed, but both outcomes are kept.
    expect(outcomes.map((o) => o.ok).sort()).toEqual([false, true]);
    expect(metered).toEqual([MODEL, MODEL]);
  });
});

describe('geometry helpers', () => {
  it('derives size from the original and measures the aspect change like the integrity check', () => {
    expect(requestedSizeFor({ width: 2048, height: 1536 })).toBe('2048x1536');
    expect(
      aspectRatioChange({ width: 1024, height: 682 }, { width: 1024, height: 672 }),
    ).toBeCloseTo(0.0149, 4);
    expect(aspectRatioChange({ width: 1000, height: 500 }, { width: 2000, height: 1000 })).toBe(0);
  });
});
