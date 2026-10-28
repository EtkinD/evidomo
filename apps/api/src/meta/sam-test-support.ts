// Test support for the P1-05 SAM fixtures (imported only by tests: `sam-*.test.ts`, P1-07 integrity).
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createPriceTableCostEstimator } from '../usage/ledger.ts';
import { cassettePath, readCassette } from './fixtures.ts';
import { decodeSamMask, maskArea, type SamEncodedMask } from './sam-mask.ts';
import { parseSamImageOutput } from './sam-output.ts';
import type { Rgb } from './sam-overlay.ts';
import type { SamSegmentResult } from './sam.ts';

export const SAM = 'sam-3.1';
/** SAM accepts and echoes an effort; the lowest one is sent (docs/model-notes.md, P1-05). */
export const SAM_EFFORT = 'minimal';
export const SAMPLES_DIR = path.resolve(
  import.meta.dirname,
  '../../../../fixtures/samples/synthetic-interiors',
);

/** The shared price table, so the test also pins SAM at $2.50 per 1,000 images. */
export const samCostEstimator = createPriceTableCostEstimator();

/**
 * Optional: `P1_05_OUT_DIR=<dir>` writes overlay PNGs and a `segments.jsonl` summary there
 * (works in replay too). Use a gitignored folder such as `data/p1-05`.
 */
export const P1_05_OUT_DIR = process.env['P1_05_OUT_DIR'];

export const PHRASE_COLORS: Readonly<Record<string, Rgb>> = {
  window: [30, 144, 255],
  door: [50, 205, 50],
  radiator: [255, 140, 0],
  person: [220, 20, 60],
  'license plate': [186, 85, 211],
};

export async function readSample(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(SAMPLES_DIR, `${name}.jpg`)));
}

const responseBodySchema = z.object({
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
});

/** Every `output_text` in a cassette, verbatim as the API returned it. */
export async function recordedOutputTexts(cassette: string): Promise<string[]> {
  const { interactions } = await readCassette(cassettePath(cassette));
  return interactions.map(({ response }) => {
    if (response.body.type !== 'json') throw new Error(`${cassette}: non-JSON SAM response`);
    const body = responseBodySchema.parse(response.body.value);
    return body.output
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('');
  });
}

export async function appendSegmentSummary(
  image: string,
  result: SamSegmentResult,
  mode: string,
): Promise<void> {
  if (P1_05_OUT_DIR === undefined || P1_05_OUT_DIR === '') return;
  await mkdir(P1_05_OUT_DIR, { recursive: true });
  const line = {
    image,
    phrase: result.phrase,
    mode,
    count: result.segments.length,
    segments: result.segments.map((s) => ({ id: s.objectId, score: s.score, box: s.box })),
    ...(mode === 'record' ? { latencyMs: Math.round(result.usage.latencyMs) } : {}),
    images: result.usage.images,
    estimatedCostUsd: result.usage.estimatedCostUsd,
  };
  await appendFile(path.join(P1_05_OUT_DIR, 'segments.jsonl'), `${JSON.stringify(line)}\n`);
}

export interface RecordedMask {
  readonly mask: SamEncodedMask;
  readonly raster: Uint8Array;
  readonly area: number;
}

/**
 * Every mask in the integrity cassette with its decoded raster, smallest raster first. Tests
 * build wire records from these real payloads: the encoder is internal to `@meta-sam/parser`.
 */
export async function recordedMasks(): Promise<RecordedMask[]> {
  const texts = await recordedOutputTexts('p1-05/sam-integrity');
  return texts
    .flatMap((text) => parseSamImageOutput(text, { validateMasks: false }).instances)
    .map(({ mask }) => {
      const raster = decodeSamMask(mask);
      return { mask, raster, area: maskArea(raster) };
    })
    .sort((a, b) => a.mask.width * a.mask.height - b.mask.width * b.mask.height);
}

/** The recorded mask at `index` in `recordedMasks()` order (0 = smallest raster). */
export async function recordedMaskAt(index: number): Promise<RecordedMask> {
  const mask = (await recordedMasks())[index];
  if (mask === undefined) throw new Error(`integrity cassette has no mask #${index}`);
  return mask;
}
