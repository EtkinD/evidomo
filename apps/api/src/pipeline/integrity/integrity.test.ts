import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IntegrityAttempt, StagingOperationId } from '@evidomo/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions } from '../../definitions/loader.ts';
import { createMetaClients, type MetaClients } from '../../meta/clients.ts';
import { editMetaImageToolsOff } from '../../meta/images.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { SAM_REASONING_EFFORT, segmentImage } from '../../meta/sam.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { stagingOperation, stagingPrompt } from '../staging/operations.ts';
import { requestedSizeFor, stagingSettings, type StagingPhoto } from '../staging/stage.ts';
import { sampleStagingStep } from '../staging/testing.ts';
import {
  checkStagedPhoto,
  integritySettings,
  restageSameOperation,
  type IntegrityDeps,
  type IntegrityPhotoResult,
  type IntegritySettings,
  type Restage,
} from './check.ts';
import { compareFixedElements, type IntegrityImage } from './compare.ts';
import {
  draftFromImage,
  INTEGRITY_CASSETTE,
  INTEGRITY_INCLUDED_CASSETTES,
  ORIGINAL_IDS,
  readSampleImage,
  RECORDED_STAGING_EDITS,
  sampleIntegrityStep,
  sampleOriginal,
  sha256,
  stagedContentFor,
  type SampleEdit,
  type SampleOriginal,
} from './testing.ts';

// The integrity step's core over recorded SAM output (docs/model-notes.md, P3-05):
// 1. P1-07's six synthetic pairs with the v1 settings: the five harmless edits pass, the window
//    removal fails, is retried once, and passes or falls back depending on the retry's image;
// 2. the five P3-04 staging edits (the model's replayed output, not our re-encode; see
//    testing.ts) checked against their originals, including the kitchen declutter;
// 3. measured phrases for surfaces declutter redraws (countertop, kitchen cabinet, dining table);
// 4. the default retry re-sends exactly the staging request.
// Fixed-element SAM calls on the synthetic images replay from P1-05 and the edits from P3-04;
// only `person` on the edits, SAM on the P3-04 outputs, and the measured phrases are P3-05's.
// Record (32 SAM calls, $0.08):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api \
//     src/pipeline/integrity/integrity.test.ts
// P3_05_OUT_DIR=<dir> writes the measured numbers there as JSON (also in replay).

const replay = createMetaReplay({
  cassette: INTEGRITY_CASSETTE,
  include: INTEGRITY_INCLUDED_CASSETTES,
});
const usage = createInMemoryUsageRecorder();
const metered: string[] = [];
const meter = async <T>(modelId: string, call: () => Promise<T>): Promise<T> => {
  metered.push(modelId);
  return call();
};
const measurements: Record<string, unknown> = {};
let clients: MetaClients;
let settings: IntegritySettings;
let staging: ReturnType<typeof stagingSettings>;

beforeAll(async () => {
  const registry = await loadDefinitions();
  settings = integritySettings(sampleIntegrityStep(registry));
  staging = stagingSettings(sampleStagingStep(registry));
  await replay.start();
  clients = createMetaClients({
    apiKey: replay.apiKey,
    usage,
    estimateCost: createPriceTableCostEstimator(),
    // One attempt: a retried call would be billed again and recorded as a second measurement.
    maxRetries: 0,
  });
});

afterEach(() => {
  replay.assertAllMatched();
});

afterAll(async () => {
  await replay.stop();
  const outDir = process.env['P3_05_OUT_DIR'];
  if (outDir !== undefined && outDir !== '') {
    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(outDir, `integrity-${replay.mode}.json`),
      `${JSON.stringify(measurements, null, 2)}\n`,
    );
  }
});

function deps(restage: Restage): IntegrityDeps {
  return { clients, meter, restage, staging };
}

const noRetry: Restage = () => {
  throw new Error('a passing edit must not be retried');
};

/** A retry that "returns" a committed image instead of calling the image model. */
function retryWith(bytes: Uint8Array): Restage {
  return (_deps, _settings, photo, operationId) =>
    Promise.resolve({ ok: true, value: draftFromImage(photo, operationId, bytes) });
}

async function check(
  originalName: SampleOriginal,
  editBytes: Uint8Array,
  operationId: StagingOperationId,
  restage: Restage,
): Promise<IntegrityPhotoResult> {
  const original = await sampleOriginal(originalName);
  const draft = draftFromImage(original, operationId, editBytes);
  return checkStagedPhoto(deps(restage), settings, {
    original,
    stagedArtifactId: '6c1b6a43-0000-4000-8000-000000000001',
    staged: stagedContentFor({ ...original, sha256: sha256(original.bytes) }, draft),
    stagedBytes: editBytes,
  });
}

function summary(attempt: IntegrityAttempt | undefined): unknown {
  if (attempt?.status !== 'checked') return attempt;
  return {
    passed: attempt.passed,
    failedClasses: attempt.verdict.failedClasses,
    aspectRatioChange: Number(attempt.verdict.aspectRatioChange.toFixed(4)),
    counts: Object.fromEntries(
      attempt.verdict.classes.map((c) => [c.label, `${c.originalCount}→${c.editCount}`]),
    ),
    worstIoU: Object.fromEntries(
      attempt.verdict.classes.map((c) => [c.label, c.worstMatchedIoU?.toFixed(2) ?? null]),
    ),
    privacy: attempt.privacy.phrases,
  };
}

const BENIGN: readonly (readonly [SampleOriginal, SampleEdit, StagingOperationId])[] = [
  ['living-empty', 'living-empty.edit-add-sofa', 'furnish_living_room'],
  ['living-dining-cluttered', 'living-dining-cluttered.edit-declutter-table', 'declutter'],
  ['bedroom-empty', 'bedroom-empty.edit-add-bed', 'furnish_bedroom'],
  ['hallway', 'hallway.edit-add-rug-plant', 'declutter'],
  ['dining-chairs', 'dining-chairs.edit-replace-chairs', 'furnish_dining_room'],
];

describe(`integrity check on the P1-07 synthetic pairs (${replay.mode})`, () => {
  it.each(BENIGN)('passes %s → %s without a retry', async (original, edit, operation) => {
    metered.length = 0;
    const result = await check(original, await readSampleImage(edit), operation, noRetry);
    measurements[`p1-07:${edit}`] = summary(result.attempts[0]);
    expect(result.outcome).toBe('passed');
    expect(result.attempts).toHaveLength(1);
    const [attempt] = result.attempts;
    if (attempt?.status !== 'checked') throw new Error('not checked');
    expect(attempt.verdict.passed).toBe(true);
    expect(attempt.privacy).toEqual({ passed: true, phrases: [{ phrase: 'person', count: 0 }] });
    // 3 SAM calls on the original, 3 + 1 (person) on the edit.
    expect(metered).toEqual(Array.from({ length: 7 }, () => 'sam-3.1'));
  });

  it('rejects the window removal, retries once, and accepts a structurally intact retry', async () => {
    metered.length = 0;
    const removed = await readSampleImage('living-empty.edit-remove-window');
    const intact = await readSampleImage('living-empty.edit-add-sofa');
    const result = await check('living-empty', removed, 'furnish_living_room', retryWith(intact));
    expect(result.outcome).toBe('passed_on_retry');
    const [first, second] = result.attempts;
    if (first?.status !== 'checked' || second?.status !== 'checked') throw new Error('unchecked');
    expect(first.passed).toBe(false);
    expect(first.verdict.failedClasses).toEqual(['window']);
    expect(first.verdict.classes.find((c) => c.label === 'window')).toMatchObject({
      originalCount: 1,
      editCount: 0,
      failures: ['count_changed', 'unmatched_original'],
    });
    expect(second).toMatchObject({ attempt: 2, passed: true });
    expect(result.retry?.operation.id).toBe('furnish_living_room');
    // The original is segmented once and reused for the retry: 3 + 4 + 4.
    expect(metered).toHaveLength(11);
  });

  it('falls back to the original when the retry fails as well', async () => {
    const removed = await readSampleImage('living-empty.edit-remove-window');
    const result = await check('living-empty', removed, 'furnish_living_room', retryWith(removed));
    expect(result.outcome).toBe('fallback_original');
    expect(result.attempts.map((a) => a.status === 'checked' && a.passed)).toEqual([false, false]);
  });

  it('falls back to the original when the retry edit produces no image', async () => {
    const removed = await readSampleImage('living-empty.edit-remove-window');
    const result = await check('living-empty', removed, 'furnish_living_room', () =>
      Promise.resolve({ ok: false, reason: 'no_image' }),
    );
    expect(result.outcome).toBe('fallback_original');
    expect(result.attempts[1]).toEqual({ status: 'edit_failed', attempt: 2, reason: 'no_image' });
    expect(result.retry).toBeUndefined();
  });
});

/** The model's output for one P3-04 edit, replayed byte for byte from its cassette. */
async function recordedStagingEdit(
  original: StagingPhoto,
  operationId: StagingOperationId,
): Promise<Uint8Array> {
  const result = await editMetaImageToolsOff(clients, {
    modelId: staging.imageModel,
    prompt: stagingPrompt(stagingOperation(operationId)),
    image: { bytes: original.bytes, mediaType: original.mediaType },
    size: requestedSizeFor(original),
    outputFormat: 'jpeg',
  });
  const [image] = result.images;
  if (image === undefined) throw new Error('recorded edit has no image');
  return image.bytes;
}

describe(`integrity check on the P3-04 staging edits (${replay.mode})`, () => {
  /**
   * Measured on the recording (docs/model-notes.md, P3-05): counts per class and the worst
   * matched IoU. All five pass, including the kitchen declutter whose redrawn worktop and base
   * cabinets are not a fixed-element class (door counts cabinet doors: 9 on both sides).
   */
  const EXPECTED: Readonly<Record<SampleOriginal, unknown>> = {
    'living-empty': { counts: ['1→1', '1→1', '1→1'], worstIoU: ['0.92', '0.95', '0.96'] },
    'dining-chairs': { counts: ['1→1', '1→1', '1→1'], worstIoU: ['0.98', '0.97', '0.95'] },
    'bedroom-empty': { counts: ['1→1', '4→4', '1→1'], worstIoU: ['0.98', '0.83', '0.94'] },
    'living-dining-cluttered': {
      counts: ['2→2', '1→1', '2→2'],
      worstIoU: ['0.95', '0.99', '0.90'],
    },
    'kitchen-cluttered': { counts: ['1→1', '9→9', '1→1'], worstIoU: ['0.92', '0.85', '0.98'] },
    hallway: null,
  };

  it.each(RECORDED_STAGING_EDITS)('checks %s (%s)', async (name, operationId) => {
    const original = await sampleOriginal(name);
    const edit = await recordedStagingEdit(original, operationId);
    const result = await check(name, edit, operationId, noRetry);
    measurements[`p3-04:${name}`] = summary(result.attempts[0]);
    expect(result.outcome).toBe('passed');
    const [attempt] = result.attempts;
    if (attempt?.status !== 'checked') throw new Error('not checked');
    expect({
      counts: attempt.verdict.classes.map((c) => `${c.originalCount}→${c.editCount}`),
      worstIoU: attempt.verdict.classes.map((c) => c.worstMatchedIoU?.toFixed(2)),
    }).toEqual(EXPECTED[name]);
    // The replayed blobs are 960×640 against 1024×682 originals (P3-04 downscaled them).
    expect(attempt.verdict.aspectRatioChange).toBeCloseTo(0.001, 3);
    expect(attempt.privacy.passed).toBe(true);
  });
});

/** SAM's instances for one phrase, as a one-class comparison image. */
async function segmentOne(bytes: Uint8Array, phrase: string): Promise<IntegrityImage> {
  const result = await segmentImage(clients, {
    modelId: settings.segmentationModel,
    phrase,
    image: bytes,
    reasoningEffort: SAM_REASONING_EFFORT,
  });
  return {
    width: result.image.width,
    height: result.image.height,
    segments: { [phrase]: result.segments },
  };
}

describe(`phrases for surfaces a declutter edit redraws (${replay.mode}, measurement only)`, () => {
  /**
   * Measured once (one recording each); not part of the defaults. `countertop` fails the
   * kitchen declutter on IoU (one counter both sides, 0.56 < 0.75), `kitchen cabinet` on count
   * (11 → 9, the two lost instances unmatched); SAM finds no `dining table` in either image.
   */
  const CASES = [
    ['kitchen-cluttered', 'countertop', { passed: false, counts: '1→1', bestIoU: '0.56' }],
    ['kitchen-cluttered', 'kitchen cabinet', { passed: false, counts: '11→9', bestIoU: '0.99' }],
    ['living-dining-cluttered', 'dining table', { passed: true, counts: '0→0', bestIoU: null }],
  ] as const;

  it.each(CASES)('measures %s with "%s"', async (name, phrase, expected) => {
    const original = await sampleOriginal(name);
    const edit = await recordedStagingEdit(original, 'declutter');
    const verdict = compareFixedElements(
      await segmentOne(original.bytes, phrase),
      await segmentOne(edit, phrase),
      { elements: [{ label: phrase, occlusionTolerant: false }] },
    );
    const [report] = verdict.classes;
    if (report === undefined) throw new Error('no class report');
    const ious = [
      ...report.matches.map((m) => m.iou),
      ...report.unmatchedOriginal.map((u) => u.bestIoU),
    ];
    const bestIoU = ious.length === 0 ? null : Math.max(...ious).toFixed(2);
    measurements[`declutter:${name}:${phrase}`] = {
      passed: verdict.passed,
      counts: `${report.originalCount}→${report.editCount}`,
      matches: report.matches.map((m) => ({
        iou: Number(m.iou.toFixed(3)),
        containment: Number(m.containment.toFixed(3)),
        areaRatio: Number(m.areaRatio.toFixed(3)),
      })),
      unmatchedOriginal: report.unmatchedOriginal,
      unmatchedEdit: report.unmatchedEdit,
      failures: report.failures,
    };
    expect({
      passed: verdict.passed,
      counts: `${report.originalCount}→${report.editCount}`,
      bestIoU,
    }).toEqual(expected);
  });
});

describe(`the default retry (${replay.mode})`, () => {
  it("re-sends the staging step's request for the same declared operation", async () => {
    metered.length = 0;
    const original = await sampleOriginal('living-empty');
    const outcome = await restageSameOperation(
      { clients, meter },
      staging,
      original,
      'furnish_living_room',
    );
    if (!outcome.ok) throw new Error(`retry failed: ${outcome.reason}`);
    expect(outcome.value).toMatchObject({
      materialId: ORIGINAL_IDS['living-empty'],
      operation: stagingOperation('furnish_living_room'),
      requestedSize: '1024x682',
    });
    expect(outcome.value.aspectRatioChange).toBeLessThan(0.03);
    expect(metered).toEqual(['muse-image-1.0']);
  });
});
