import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMetaClients, type MetaClients } from './clients.ts';
import { imageDimensions, type MetaImageResult } from './images.ts';
import { exportImageResult } from './muse-image-export.ts';
import { createMetaReplay } from './replay.ts';
import { createInMemoryUsageRecorder, createTokenPriceEstimator } from './usage.ts';

// P1-08: a Muse Image edit with every built-in tool disabled, through the `openai` SDK.
// The AI SDK image model cannot send `tool_enablement` (P1-06), and Meta enables image search,
// web search, and shell by default, so staging customer photos needs this path.
// Record (spends $0.01): RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run
//   --project api muse-image-tools-off   (docs/model-notes.md, P1-08)

const MUSE_IMAGE = 'muse-image-1.0';
const LIVE_TIMEOUT_MS = 300_000;
const INPUT = path.resolve(
  import.meta.dirname,
  '../../../../fixtures/samples/synthetic-interiors/living-empty.jpg',
);

// Same operation and prompt as the P1-06 `living-empty` sofa edit (sent with tools on), so the
// two recordings differ only in transport and `tool_enablement`.
const PROMPT =
  'Edit this photo: add a light grey three-seat fabric sofa in the room, facing the window. ' +
  'Change nothing else: keep the camera angle, framing, walls, floor, ceiling, windows, doors, ' +
  'radiators, and lighting exactly as they are. Do not add people, text, or logos.';

const TOOLS_OFF = {
  enable_image_search: false,
  enable_web_search: false,
  enable_shell: false,
} as const;

/** Fields of Meta's documented `Images Response`; anything else would be a format change. */
const DOCUMENTED_RESPONSE_FIELDS = ['created', 'data', 'output_format', 'background', 'usage'];

const imagesResponseSchema = z.object({
  created: z.number().int(),
  data: z.array(z.object({ b64_json: z.string().min(1) })).min(1),
  output_format: z.string().optional(),
  background: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});

const replay = createMetaReplay({ cassette: 'p1-08/muse-image-tools-off' });
const usage = createInMemoryUsageRecorder();
const estimateCost = createTokenPriceEstimator({ [MUSE_IMAGE]: { usdPerImage: 0.01 } });
let clients: MetaClients;

beforeAll(async () => {
  await replay.start();
  // One attempt: a retried edit would be a second measurement, not this one.
  clients = createMetaClients({ apiKey: replay.apiKey, usage, estimateCost, maxRetries: 0 });
});

afterEach(() => {
  usage.clear();
  replay.assertAllMatched();
});

afterAll(async () => {
  await replay.stop();
});

describe(`${MUSE_IMAGE} edit with tools disabled, openai SDK JSON body (${replay.mode})`, () => {
  it(
    'accepts tool_enablement on the JSON edit body and returns one billed image',
    async () => {
      const input = await readFile(INPUT);
      expect(imageDimensions(input)).toMatchObject({ format: 'jpeg', width: 1024, height: 682 });

      // Meta's JSON edit body (`images[].image_url`), not multipart: nested `tool_enablement`
      // is parsed strictly here (a non-boolean is a 400 naming the field, P1-08 probe).
      const body = {
        model: MUSE_IMAGE,
        prompt: PROMPT,
        images: [{ image_url: `data:image/jpeg;base64,${input.toString('base64')}` }],
        n: 1,
        size: '1536x1024',
        output_format: 'jpeg',
        response_format: 'b64_json',
        tool_enablement: TOOLS_OFF,
      };

      const startedAt = performance.now();
      const raw = await clients.openai.post<unknown>('/images/edits', { body });
      const latencyMs = performance.now() - startedAt;

      // The response has no field that reports tool use (Meta's schema documents none); this
      // pins that, so a new field shows up as a failure on re-recording.
      const fields = Object.keys(z.record(z.string(), z.unknown()).parse(raw));
      expect(fields.filter((field) => !DOCUMENTED_RESPONSE_FIELDS.includes(field))).toEqual([]);
      const response = imagesResponseSchema.parse(raw);
      const images = response.data.map((item) => {
        const bytes = new Uint8Array(Buffer.from(item.b64_json, 'base64'));
        return { ...imageDimensions(bytes), bytes };
      });
      const entry = clients.recordUsage({
        sdk: 'openai',
        modelId: MUSE_IMAGE,
        inputTokens: response.usage?.input_tokens,
        cachedInputTokens: undefined,
        outputTokens: response.usage?.output_tokens,
        reasoningTokens: undefined,
        totalTokens: response.usage?.total_tokens,
        responseId: undefined,
        latencyMs,
        images: images.length,
      });
      const result: MetaImageResult = {
        images,
        usage: entry,
        outputFormat: response.output_format,
        warnings: [],
      };
      await exportImageResult('living-empty.edit-add-sofa.tools-off', result, replay.mode, {
        kind: 'edit',
        transport: 'openai-json',
        toolEnablement: TOOLS_OFF,
      });

      expect(images).toHaveLength(1);
      // Same output geometry as the P1-06 multipart edits with `size` 1536x1024.
      expect(images[0]).toMatchObject({ format: 'jpeg', width: 1920, height: 1280 });
      expect(response.output_format).toBe('jpeg');
      expect(usage.entries).toEqual([entry]);
      expect(entry).toMatchObject({ sdk: 'openai', modelId: MUSE_IMAGE, images: 1 });
      expect(entry.estimatedCostUsd).toBeCloseTo(0.01, 10);
      expect(entry.inputTokens).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );
});
