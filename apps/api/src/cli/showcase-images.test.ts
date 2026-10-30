import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetaClients } from '../meta/clients.ts';
import { createInMemoryUsageRecorder, createTokenPriceEstimator } from '../meta/usage.ts';
import {
  buildShowcaseManifest,
  generateShowcaseImages,
  planShowcaseImages,
  SHOWCASE_CONSTRAINTS,
  ShowcasePlanError,
  showcaseManifestSchema,
  type PlannedShowcaseImage,
} from './showcase-images.ts';
import { SHOWCASE_DIRECTIONS, SHOWCASE_IMAGES } from './showcase-prompts.ts';

const MODEL = 'image-model';
const WEBP_3X2 = await sharp({
  create: { width: 3, height: 2, channels: 3, background: { r: 200, g: 200, b: 200 } },
})
  .webp()
  .toBuffer();

describe('planShowcaseImages', () => {
  const plan = planShowcaseImages(SHOWCASE_DIRECTIONS, SHOWCASE_IMAGES);

  it('plans 4 logos, 2 heroes, 2 interiors, and 2 illustrations per direction', () => {
    expect(plan).toHaveLength(30);
    for (const direction of ['A', 'B', 'C']) {
      const ids = plan.filter((item) => item.direction === direction).map((item) => item.id);
      expect(ids).toEqual([
        ...[1, 2, 3, 4].map((n) => `${direction}-LOGO-${String(n)}`),
        `${direction}-HERO-1`,
        `${direction}-HERO-2`,
        `${direction}-INT-1`,
        `${direction}-INT-2`,
        `${direction}-ILL-1`,
        `${direction}-ILL-2`,
      ]);
    }
    expect(new Set(plan.map((item) => item.file)).size).toBe(30);
  });

  it('gives square logos and illustrations, 3:2 photos, and WebP files under the direction', () => {
    expect(plan.find((item) => item.id === 'A-LOGO-1')).toMatchObject({
      kind: 'logo-concept',
      file: 'A/logo-1.webp',
      size: '1024x1024',
    });
    expect(plan.find((item) => item.id === 'B-HERO-2')).toMatchObject({
      kind: 'hero',
      file: 'B/hero-2.webp',
      size: '1536x1024',
    });
    expect(plan.find((item) => item.id === 'C-INT-1')).toMatchObject({
      kind: 'interior',
      file: 'C/interior-1.webp',
      size: '1536x1024',
    });
    expect(plan.find((item) => item.id === 'C-ILL-2')).toMatchObject({
      kind: 'illustration',
      file: 'C/illustration-2.webp',
      size: '1024x1024',
    });
  });

  it("puts the direction's palette and the no-people, no-text constraints in every prompt", () => {
    for (const item of plan) {
      const direction = SHOWCASE_DIRECTIONS.find((d) => d.id === item.direction);
      expect(item.prompt).toContain(direction?.palette);
      expect(item.prompt.endsWith(SHOWCASE_CONSTRAINTS)).toBe(true);
    }
    expect(SHOWCASE_CONSTRAINTS).toMatch(/No people, no faces/);
    expect(SHOWCASE_CONSTRAINTS).toMatch(/No text/);
    expect(SHOWCASE_CONSTRAINTS).toMatch(/No licence plates/);
  });

  it('rejects a spec for an unknown direction', () => {
    expect(() =>
      planShowcaseImages(SHOWCASE_DIRECTIONS.slice(0, 1), [
        { direction: 'B', kind: 'hero', subject: 'x' },
      ]),
    ).toThrow(ShowcasePlanError);
  });
});

describe('buildShowcaseManifest', () => {
  it('lists generated items in plan order and leaves out the rest', () => {
    const plan = planShowcaseImages(SHOWCASE_DIRECTIONS, SHOWCASE_IMAGES).slice(0, 3);
    const item = (planned: PlannedShowcaseImage) => ({
      id: planned.id,
      direction: planned.direction,
      kind: planned.kind,
      file: planned.file,
      prompt: planned.prompt,
      width: 1024,
      height: 1024,
    });
    const [first, second, third] = plan;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('plan too short');
    }
    const manifest = buildShowcaseManifest(
      plan,
      new Map([
        [third.id, item(third)],
        [first.id, item(first)],
      ]),
      new Date('2026-10-30T12:00:00.000Z'),
      'generations',
    );
    expect(manifest).toEqual({
      generatedAt: '2026-10-30T12:00:00.000Z',
      toolsOff: 'generations',
      items: [item(first), item(third)],
    });
    expect(showcaseManifestSchema.parse(manifest)).toEqual(manifest);
  });
});

describe('generateShowcaseImages (stubbed fetch, no network)', () => {
  const usage = createInMemoryUsageRecorder();
  const estimateCost = createTokenPriceEstimator({ [MODEL]: { usdPerImage: 0.01 } });
  const clients = createMetaClients({ apiKey: 'k', usage, estimateCost, maxRetries: 0 });
  const plan = planShowcaseImages(SHOWCASE_DIRECTIONS, SHOWCASE_IMAGES).filter((item) =>
    ['A-LOGO-1', 'A-HERO-1'].includes(item.id),
  );
  const requests: Request[] = [];
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'showcase-images-'));
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Promise.resolve(
        Response.json({
          created: 1,
          data: [{ b64_json: WEBP_3X2.toString('base64') }],
          output_format: 'webp',
          background: 'opaque',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    requests.length = 0;
    usage.clear();
    await rm(outDir, { recursive: true, force: true });
  });

  const run = (overrides: { only?: ReadonlySet<string>; maxUsd?: number } = {}) =>
    generateShowcaseImages({
      clients,
      usage,
      modelId: MODEL,
      outDir,
      plan,
      maxUsd: overrides.maxUsd ?? 1,
      usdPerImage: 0.01,
      concurrency: 1,
      progress: () => undefined,
      now: () => new Date('2026-10-30T12:00:00.000Z'),
      ...(overrides.only === undefined ? {} : { only: overrides.only }),
    });

  it('posts the generations JSON body with every tool off and writes images and the manifest', async () => {
    const result = await run();

    expect(requests).toHaveLength(2);
    const [sent] = requests;
    expect(sent?.url).toBe('https://api.meta.ai/v1/images/generations');
    expect(sent?.headers.get('content-type')).toContain('application/json');
    expect(await sent?.json()).toEqual({
      model: MODEL,
      prompt: plan[0]?.prompt,
      n: 1,
      size: '1024x1024',
      output_format: 'webp',
      response_format: 'b64_json',
      tool_enablement: {
        enable_image_search: false,
        enable_web_search: false,
        enable_shell: false,
      },
    });
    expect(await requests[1]?.json()).toMatchObject({ size: '1536x1024' });

    expect(await readFile(path.join(outDir, 'A', 'logo-1.webp'))).toEqual(WEBP_3X2);
    expect((await stat(path.join(outDir, 'A', 'hero-1.webp'))).isFile()).toBe(true);
    const manifest = showcaseManifestSchema.parse(
      JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8')),
    );
    expect(manifest).toEqual(result.manifest);
    expect(manifest).toEqual({
      generatedAt: '2026-10-30T12:00:00.000Z',
      toolsOff: 'generations',
      items: plan.map((item) => ({
        id: item.id,
        direction: item.direction,
        kind: item.kind,
        file: item.file,
        prompt: item.prompt,
        width: 3,
        height: 2,
      })),
    });
    expect(result).toMatchObject({
      generated: ['A-LOGO-1', 'A-HERO-1'],
      kept: [],
      failed: [],
      notAttempted: [],
    });
    expect(result.spentUsd).toBeCloseTo(0.02, 10);
  });

  it('keeps images from an earlier run and regenerates only the IDs asked for', async () => {
    await run();
    requests.length = 0;

    const again = await run();
    expect(requests).toHaveLength(0);
    expect(again).toMatchObject({ generated: [], kept: ['A-LOGO-1', 'A-HERO-1'] });
    expect(again.manifest.items).toHaveLength(2);

    const redo = await run({ only: new Set(['A-HERO-1']) });
    expect(requests).toHaveLength(1);
    expect(await requests[0]?.json()).toMatchObject({ size: '1536x1024' });
    expect(redo).toMatchObject({ generated: ['A-HERO-1'], kept: ['A-LOGO-1'] });
    expect(redo.manifest.items.map((item) => item.id)).toEqual(['A-LOGO-1', 'A-HERO-1']);
  });

  it('starts no call that could exceed the spend cap', async () => {
    const result = await run({ maxUsd: 0.015 });
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ generated: ['A-LOGO-1'], notAttempted: ['A-HERO-1'] });
    expect(result.manifest.items.map((item) => item.id)).toEqual(['A-LOGO-1']);
  });

  it('rejects unknown IDs in only before any call', async () => {
    await expect(run({ only: new Set(['A-LOGO-9']) })).rejects.toThrow(ShowcasePlanError);
    expect(requests).toHaveLength(0);
  });
});
