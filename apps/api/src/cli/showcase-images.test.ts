import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  it('plans B unchanged (4 logos) and 2 logos for each Hearth variant, then 2 of each photo kind', () => {
    expect(plan).toHaveLength(26);
    expect(new Set(plan.map((item) => item.direction))).toEqual(new Set(['B', 'B2', 'B3']));
    const rest = (direction: string) => [
      `${direction}-HERO-1`,
      `${direction}-HERO-2`,
      `${direction}-INT-1`,
      `${direction}-INT-2`,
      `${direction}-ILL-1`,
      `${direction}-ILL-2`,
    ];
    const idsOf = (direction: string) =>
      plan.filter((item) => item.direction === direction).map((item) => item.id);
    expect(idsOf('B')).toEqual([...[1, 2, 3, 4].map((n) => `B-LOGO-${String(n)}`), ...rest('B')]);
    for (const direction of ['B2', 'B3']) {
      expect(idsOf(direction)).toEqual([
        `${direction}-LOGO-1`,
        `${direction}-LOGO-2`,
        ...rest(direction),
      ]);
    }
    expect(new Set(plan.map((item) => item.file)).size).toBe(26);
    expect(new Set(plan.map((item) => item.prompt)).size).toBe(26);
  });

  it('gives square logos and illustrations, 3:2 photos, and WebP files under the direction', () => {
    expect(plan.find((item) => item.id === 'B2-LOGO-1')).toMatchObject({
      kind: 'logo-concept',
      file: 'B2/logo-1.webp',
      size: '1024x1024',
    });
    expect(plan.find((item) => item.id === 'B-HERO-2')).toMatchObject({
      kind: 'hero',
      file: 'B/hero-2.webp',
      size: '1536x1024',
    });
    expect(plan.find((item) => item.id === 'B3-INT-1')).toMatchObject({
      kind: 'interior',
      file: 'B3/interior-1.webp',
      size: '1536x1024',
    });
    expect(plan.find((item) => item.id === 'B3-ILL-2')).toMatchObject({
      kind: 'illustration',
      file: 'B3/illustration-2.webp',
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
      planShowcaseImages(SHOWCASE_DIRECTIONS.slice(0, 2), [
        { direction: 'B3', kind: 'hero', subject: 'x' },
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
    ['B2-LOGO-1', 'B2-HERO-1'].includes(item.id),
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

    expect(await readFile(path.join(outDir, 'B2', 'logo-1.webp'))).toEqual(WEBP_3X2);
    expect((await stat(path.join(outDir, 'B2', 'hero-1.webp'))).isFile()).toBe(true);
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
      generated: ['B2-LOGO-1', 'B2-HERO-1'],
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
    expect(again).toMatchObject({ generated: [], kept: ['B2-LOGO-1', 'B2-HERO-1'] });
    expect(again.manifest.items).toHaveLength(2);

    const redo = await run({ only: new Set(['B2-HERO-1']) });
    expect(requests).toHaveLength(1);
    expect(await requests[0]?.json()).toMatchObject({ size: '1536x1024' });
    expect(redo).toMatchObject({ generated: ['B2-HERO-1'], kept: ['B2-LOGO-1'] });
    expect(redo.manifest.items.map((item) => item.id)).toEqual(['B2-LOGO-1', 'B2-HERO-1']);
  });

  it('drops earlier manifest items that are no longer planned', async () => {
    const [kept] = plan;
    if (kept === undefined) throw new Error('plan too short');
    const unplanned = { ...kept, id: 'B3-LOGO-1', file: 'B3/logo-1.webp' };
    const entry = (item: PlannedShowcaseImage) => ({
      id: item.id,
      direction: item.direction,
      kind: item.kind,
      file: item.file,
      prompt: item.prompt,
      width: 3,
      height: 2,
    });
    for (const item of [kept, unplanned]) {
      await mkdir(path.join(outDir, path.dirname(item.file)), { recursive: true });
      await writeFile(path.join(outDir, item.file), WEBP_3X2);
    }
    await writeFile(
      path.join(outDir, 'manifest.json'),
      JSON.stringify({
        generatedAt: '2026-10-29T12:00:00.000Z',
        toolsOff: 'generations',
        items: [entry(kept), { ...entry(kept), id: unplanned.id, file: unplanned.file }],
      }),
    );

    const result = await run();
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ generated: ['B2-HERO-1'], kept: ['B2-LOGO-1'] });
    const manifest = showcaseManifestSchema.parse(
      JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8')),
    );
    expect(manifest.items.map((item) => item.id)).toEqual(['B2-LOGO-1', 'B2-HERO-1']);
  });

  it('starts no call that could exceed the spend cap', async () => {
    const result = await run({ maxUsd: 0.015 });
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ generated: ['B2-LOGO-1'], notAttempted: ['B2-HERO-1'] });
    expect(result.manifest.items.map((item) => item.id)).toEqual(['B2-LOGO-1']);
  });

  it('rejects unknown IDs in only before any call', async () => {
    await expect(run({ only: new Set(['B2-LOGO-9']) })).rejects.toThrow(ShowcasePlanError);
    expect(requests).toHaveLength(0);
  });
});
