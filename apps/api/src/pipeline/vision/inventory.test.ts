import { photoInventoryContentSchema, type PhotoInventoryContent } from '@evidomo/shared';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { imageDimensions } from '../../meta/images.ts';
import { recordedMaskAt, type RecordedMask } from '../../meta/sam-test-support.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { NonRetryableStepError, type StepConfig } from '../../runs/steps.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import {
  privacyStatusOf,
  runVisionInventory,
  visionSettings,
  type VisionPhoto,
  type VisionSettings,
} from './inventory.ts';
import { loadSamplePhotos, sampleVisionStep } from './testing.ts';

// The inventory core against a stubbed fetch (no network, no fixtures): photo-level failures,
// privacy statuses, the evidence cap, the mask cap, and the Spark downscale. Behaviour on the
// real models is covered by vision-inventory.test.ts.

const requestSchema = z.object({
  model: z.string(),
  input: z.array(
    z.object({
      role: z.string(),
      content: z
        .array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
            image_url: z.string().optional(),
          }),
        )
        .or(z.string()),
    }),
  ),
});

interface SentRequest {
  readonly model: string;
  /** The SAM phrase, or the Spark user text. */
  readonly text: string;
  readonly image: Uint8Array;
}

function parseRequest(body: unknown): SentRequest {
  const parsed = requestSchema.parse(body);
  const user = parsed.input.find((item) => item.role === 'user');
  if (user === undefined || typeof user.content === 'string') throw new Error('no user content');
  const text = user.content.find((part) => part.type === 'input_text')?.text ?? '';
  const url = user.content.find((part) => part.type === 'input_image')?.image_url ?? '';
  const base64 = url.slice(url.indexOf(',') + 1);
  return { model: parsed.model, text, image: new Uint8Array(Buffer.from(base64, 'base64')) };
}

function responseBody(model: string, text: string, usage: Record<string, unknown>) {
  return {
    id: 'resp_test',
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
    usage,
  };
}

const SPARK_USAGE = {
  input_tokens: 2000,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 800,
  output_tokens_details: { reasoning_tokens: 600 },
  total_tokens: 2800,
};
const SAM_USAGE = {
  input_tokens: 0,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 0,
  images_processed: 1,
};

interface Answer {
  subject?: string;
  coverScore?: number;
  quality?: string;
  observations?: { object: string; otherObject: string | null; count: number; detail: string }[];
  privacySubjects?: string[];
}

function sparkAnswer(answer: Answer): string {
  return JSON.stringify({
    subject: answer.subject ?? 'living_room',
    otherSubject: null,
    summary: 'Empty room with a window.',
    quality: answer.quality ?? 'good',
    qualityIssues: [],
    coverScore: answer.coverScore ?? 5,
    observations: answer.observations ?? [],
    privacySubjects: answer.privacySubjects ?? [],
  });
}

let MASK: RecordedMask;

/** `count` SAM records of the recorded 25×275 mask at different x offsets, on a w×h image. */
function samLine(count: number, w = 1024, h = 682, score = 0.8): string {
  if (count === 0) return '';
  const { width, height, payload } = MASK.mask;
  const records = Array.from({ length: count }, (_, i) => {
    const x = 10 + i * 40;
    return `${i === 0 ? '' : ','}${i}<|box;x1=${x};y1=20;x2=${x + width - 1};y2=${20 + height - 1};w=${w};h=${h};c=${score}|><|mask;x=0;y=0;c=${score};data=${height},${width},${payload}|>`;
  });
  return `<0f>${records.join('')}\n`;
}

type Reply =
  | { readonly kind: 'json'; readonly body: unknown }
  | { readonly kind: 'status'; readonly status: number };

/** Routes each request to a reply by photo index (image bytes) and model/phrase. */
function stubMeta(
  photos: readonly VisionPhoto[],
  route: (photoIndex: number, request: SentRequest) => Reply,
): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal('fetch', (_input: string | URL | Request, init?: RequestInit) => {
    const request = parseRequest(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    sent.push(request);
    let index = photos.findIndex((p) => Buffer.from(p.bytes).equals(Buffer.from(request.image)));
    // A downscaled Spark copy matches no stored photo; tests with it use one photo.
    if (index < 0) index = 0;
    const reply = route(index, request);
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

const spark = (answer: Answer | string): Reply => ({
  kind: 'json',
  body: responseBody(
    'muse-spark-1.3',
    typeof answer === 'string' ? answer : sparkAnswer(answer),
    SPARK_USAGE,
  ),
});
const sam = (text: string): Reply => ({
  kind: 'json',
  body: responseBody('sam-3.1', text, SAM_USAGE),
});

const usage = createInMemoryUsageRecorder();
const clients = createMetaClients({
  apiKey: 'k',
  usage,
  estimateCost: createPriceTableCostEstimator(),
  maxRetries: 0,
});
const passThrough = async <T>(_modelId: string, call: () => Promise<T>): Promise<T> => call();
let registry: DefinitionRegistry;
let samples: VisionPhoto[];

function settings(overrides: Partial<StepConfig<'vision'>> = {}): VisionSettings {
  return visionSettings(
    { ...sampleVisionStep(registry), ...overrides },
    registry.getMarket('nl', 1),
  );
}

async function inventory(
  photos: readonly VisionPhoto[],
  s: VisionSettings = settings(),
): Promise<{ content: PhotoInventoryContent; facts: number }> {
  const result = await runVisionInventory({ clients, meter: passThrough }, s, photos);
  return { content: photoInventoryContentSchema.parse(result.content), facts: result.facts.length };
}

beforeAll(async () => {
  registry = await loadDefinitions();
  samples = await loadSamplePhotos();
  MASK = await recordedMaskAt(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  usage.clear();
});

const WINDOW = { object: 'window', otherObject: null, count: 1, detail: 'a window' };
const RADIATOR = { object: 'radiator', otherObject: null, count: 1, detail: 'a radiator' };

describe('runVisionInventory (stubbed fetch)', () => {
  it('marks privacy as failed for a photo whose privacy output is malformed, and keeps going', async () => {
    const photos = samples.slice(0, 3);
    stubMeta(photos, (index, request) => {
      if (request.model.startsWith('muse')) return spark({ coverScore: 3 + index });
      if (index === 1 && request.text === 'person') return sam('<0f>garbage\n');
      return sam('');
    });
    const { content } = await inventory(photos);
    expect(content.photos.map((p) => p.privacy.status)).toEqual(['clear', 'failed', 'clear']);
    const failed = content.photos[1]?.privacy.phrases.find((p) => p.phrase === 'person');
    expect(failed).toMatchObject({ status: 'failed', reason: 'invalid_output' });
    expect(content.counts.privacy).toEqual({ clear: 2, masked: 0, review: 0, failed: 1 });
    // Cover ranks follow the cover score.
    expect(
      content.photos.map((p) =>
        p.classification.status === 'ok' ? p.classification.coverRank : 0,
      ),
    ).toEqual([3, 2, 1]);
  });

  it('masks found people, and asks for review when Spark sees one that SAM does not', async () => {
    const photos = samples.slice(0, 2);
    stubMeta(photos, (index, request) => {
      if (request.model.startsWith('muse')) return spark({ privacySubjects: ['person'] });
      return sam(index === 0 && request.text === 'person' ? samLine(1) : '');
    });
    const { content } = await inventory(photos);
    expect(content.photos.map((p) => p.privacy.status)).toEqual(['masked', 'review']);
    const person = content.photos[0]?.privacy.phrases[0];
    expect(person?.status === 'checked' && person.regions[0]?.mask).toEqual(MASK.mask);
    expect(content.counts.privacyRegions).toBe(1);
  });

  it('stores a failed classification without a cover rank and still checks privacy', async () => {
    const photos = samples.slice(0, 2);
    stubMeta(photos, (index, request) => {
      if (request.model.startsWith('muse')) return spark(index === 0 ? '{"subject": 1}' : {});
      return sam('');
    });
    const { content } = await inventory(photos);
    expect(content.photos[0]?.classification).toEqual({
      status: 'failed',
      reason: 'invalid_output',
    });
    expect(content.photos[0]?.privacy.phrases.every((p) => p.modelSaw === null)).toBe(true);
    expect(content.photos[0]?.privacy.status).toBe('clear');
    expect(content.photos[1]?.classification).toMatchObject({ status: 'ok', coverRank: 1 });
    expect(content.counts).toMatchObject({ classified: 1, classificationFailed: 1 });
  });

  it('fails the step without retry when every classification fails', async () => {
    const photos = samples.slice(0, 2);
    stubMeta(photos, (_index, request) =>
      request.model.startsWith('muse') ? spark('not json') : sam(''),
    );
    await expect(inventory(photos)).rejects.toBeInstanceOf(NonRetryableStepError);
  });

  it('propagates a server error (transient for the engine) instead of failing one photo', async () => {
    const photos = samples.slice(0, 2);
    stubMeta(photos, (index, request) => {
      if (index === 1 && request.text === 'license plate') return { kind: 'status', status: 503 };
      return request.model.startsWith('muse') ? spark({}) : sam('');
    });
    await expect(inventory(photos)).rejects.not.toBeInstanceOf(NonRetryableStepError);
  });

  it('caps evidence requests per run breadth first and drops facts SAM contradicts', async () => {
    const photos = samples.slice(0, 3);
    const sent = stubMeta(photos, (index, request) => {
      if (request.model.startsWith('muse')) return spark({ observations: [WINDOW, RADIATOR] });
      if (request.text === 'radiator') return sam(index === 0 ? '' : samLine(1));
      if (request.text === 'window') return sam(samLine(2));
      return sam('');
    });
    const { content, facts } = await inventory(photos, settings({ max_evidence_masks: 3 }));
    const evidenceCalls = sent.filter((r) => r.text === 'window' || r.text === 'radiator');
    expect(evidenceCalls).toHaveLength(3);
    expect(content.evidence).toMatchObject({ cap: 3, candidateCount: 6, requestCount: 3 });
    // Radiator comes before window in nl v1; one of each first, then the next radiator.
    const status = (i: number, key: string) =>
      content.photos[i]?.observations.find((o) => o.key === key)?.evidence.status;
    expect([
      status(0, 'other:radiator'),
      status(0, 'other:window'),
      status(1, 'other:radiator'),
    ]).toEqual(['not_found', 'segmented', 'segmented']);
    expect(status(1, 'other:window')).toBe('not_requested');
    // Masks: one per answered request first (2), then one more from the window request: cap 3.
    expect(content.evidence).toMatchObject({ regionCount: 3, maskCount: 3 });
    // The radiator SAM did not find in photo 0 is not stored as a fact; the rest are.
    expect(facts).toBe(5);
    const window = content.photos[0]?.observations.find((o) => o.key === 'other:window');
    expect(window?.region.width).toBeLessThan(1);
    expect(window?.evidence.instanceCount).toBe(2);
  });

  it('keeps at most max_evidence_masks evidence masks even when one request returns many', async () => {
    const photos = samples.slice(0, 1);
    stubMeta(photos, (_index, request) => {
      if (request.model.startsWith('muse')) return spark({ observations: [WINDOW, RADIATOR] });
      if (request.text === 'window') return sam(samLine(5, 1024, 682, 0.9));
      if (request.text === 'radiator') return sam(samLine(1));
      return sam('');
    });
    const { content } = await inventory(photos, settings({ max_evidence_masks: 3 }));
    const regions = content.photos[0]?.observations.flatMap((o) => o.evidence.regions) ?? [];
    expect(regions).toHaveLength(6);
    expect(regions.filter((r) => r.mask !== null)).toHaveLength(3);
    expect(content.evidence.maskCount).toBe(3);
  });

  it('sends Spark a downscaled copy and SAM the stored photo', async () => {
    const [first] = samples;
    if (first === undefined) throw new Error('no sample');
    const big = new Uint8Array(await sharp(first.bytes).resize({ width: 2048 }).jpeg().toBuffer());
    const { width, height } = imageDimensions(big);
    const photo: VisionPhoto = { ...first, bytes: big, width, height };
    const sent = stubMeta([photo], (_index, request) =>
      request.model.startsWith('muse') ? spark({}) : sam(''),
    );
    await inventory([photo]);
    const sparkImage = sent.find((r) => r.model.startsWith('muse'))?.image;
    const samImages = sent.filter((r) => r.model === 'sam-3.1').map((r) => r.image);
    expect(sparkImage && imageDimensions(sparkImage)).toMatchObject({ width: 1024, height: 682 });
    expect(samImages).toHaveLength(2);
    for (const image of samImages) expect(Buffer.from(image).equals(Buffer.from(big))).toBe(true);
  });
});

describe('privacyStatusOf', () => {
  const checked = (regions: number, modelSaw: boolean | null) => ({
    status: 'checked' as const,
    phrase: 'person',
    modelSaw,
    regions: Array.from({ length: regions }, (_, i) => ({
      objectId: i,
      score: 0.9,
      box: { x0: 0, y0: 0, x1: 1, y1: 1 },
      region: { x: 0, y: 0, width: 0.1, height: 0.1 },
      mask: null,
    })),
  });
  const failed = {
    status: 'failed' as const,
    phrase: 'license plate',
    modelSaw: null,
    reason: 'invalid_output' as const,
  };

  it('ranks failed over review over masked over clear', () => {
    expect(privacyStatusOf([checked(0, false)])).toBe('clear');
    expect(privacyStatusOf([checked(0, null)])).toBe('clear');
    expect(privacyStatusOf([checked(1, false)])).toBe('masked');
    expect(privacyStatusOf([checked(1, true), checked(0, true)])).toBe('review');
    expect(privacyStatusOf([checked(1, true), failed])).toBe('failed');
  });
});
