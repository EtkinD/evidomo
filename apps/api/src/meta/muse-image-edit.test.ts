import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMetaClients, type MetaClients } from './clients.ts';
import { editMetaImage, imageDimensions, type MetaImageSize } from './images.ts';
import { exportImageResult } from './muse-image-export.ts';
import { createMetaReplay } from './replay.ts';
import { createInMemoryUsageRecorder, createTokenPriceEstimator } from './usage.ts';

// Record (spends 6 x $0.01): RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run
//   --project api muse-image-edit   (docs/model-notes.md, P1-06)
// Default runs replay fixtures/meta/p1-06/edit.json (+ edit.files/). Inputs are the committed
// synthetic samples, so the multipart request hashes stay stable.

const MUSE_IMAGE = 'muse-image-1.0';
const LIVE_TIMEOUT_MS = 300_000;
const SAMPLES_DIR = path.resolve(
  import.meta.dirname,
  '../../../../fixtures/samples/synthetic-interiors',
);

/** How a declared operation becomes an edit prompt (the staging step will reuse this shape). */
function declaredOperationPrompt(operation: string): string {
  return (
    `Edit this photo: ${operation}. Change nothing else: keep the camera angle, framing, ` +
    'walls, floor, ceiling, windows, doors, radiators, and lighting exactly as they are. ' +
    'Do not add people, text, or logos.'
  );
}

interface EditCase {
  readonly id: string;
  readonly input: string;
  readonly operation: string;
  /** `undefined` sends no `size`, to observe the API default for edits. */
  readonly size: MetaImageSize | undefined;
  /** True for the deliberately structure-altering edit the integrity check must reject. */
  readonly structural: boolean;
}

const EDITS: readonly EditCase[] = [
  {
    id: 'living-empty.edit-add-sofa',
    input: 'living-empty',
    operation: 'add a light grey three-seat fabric sofa in the room, facing the window',
    size: '1536x1024',
    structural: false,
  },
  {
    id: 'living-dining-cluttered.edit-declutter-table',
    input: 'living-dining-cluttered',
    operation: 'remove all clutter from the dining table so the table top is completely clear',
    size: '1536x1024',
    structural: false,
  },
  {
    id: 'bedroom-empty.edit-add-bed',
    input: 'bedroom-empty',
    operation: 'add a double bed with white linen and two pillows',
    size: '1536x1024',
    structural: false,
  },
  {
    id: 'dining-chairs.edit-replace-chairs',
    input: 'dining-chairs',
    operation: 'replace the six dining chairs with modern light oak chairs without cushions',
    size: '1536x1024',
    structural: false,
  },
  {
    id: 'hallway.edit-add-rug-plant',
    input: 'hallway',
    operation: 'add a long woven runner rug on the floor and a tall potted plant in a corner',
    size: undefined,
    structural: false,
  },
  {
    id: 'living-empty.edit-remove-window',
    input: 'living-empty',
    operation: 'remove the window and replace it with a plain white wall',
    size: '1536x1024',
    structural: true,
  },
];

const replay = createMetaReplay({ cassette: 'p1-06/edit' });
const usage = createInMemoryUsageRecorder();
const estimateCost = createTokenPriceEstimator({ [MUSE_IMAGE]: { usdPerImage: 0.01 } });
let clients: MetaClients;

beforeAll(async () => {
  await replay.start();
  clients = createMetaClients({ apiKey: replay.apiKey, usage, estimateCost });
});

afterEach(() => {
  usage.clear();
  replay.assertAllMatched();
});

afterAll(async () => {
  await replay.stop();
});

describe(`${MUSE_IMAGE} declared-operation edits (${replay.mode})`, () => {
  it.each(EDITS)(
    'edits $input: $operation',
    async (edit) => {
      const input = await readFile(path.join(SAMPLES_DIR, `${edit.input}.jpg`));
      const inputSize = imageDimensions(input);

      const result = await editMetaImage(clients, {
        modelId: MUSE_IMAGE,
        prompt: declaredOperationPrompt(edit.operation),
        images: [input],
        ...(edit.size === undefined ? {} : { size: edit.size }),
        outputFormat: 'jpeg',
      });
      await exportImageResult(edit.id, result, replay.mode, {
        kind: 'edit',
        input: edit.input,
        inputWidth: inputSize.width,
        inputHeight: inputSize.height,
        sizeParam: edit.size ?? null,
        structural: edit.structural,
      });

      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.format).toBe('jpeg');
      // Measured (P1-06): the output never keeps the 1024x682 input size. With `size` 1536x1024
      // it comes back at 1920x1280 (exact 3:2); without `size` at 1952x1280 (a slightly
      // different aspect ratio than the input). Integrity checks must resize before comparing.
      expect(inputSize).toMatchObject({ width: 1024, height: 682 });
      expect(result.images[0]).toMatchObject(
        edit.size === undefined ? { width: 1952, height: 1280 } : { width: 1920, height: 1280 },
      );
      expect(result.outputFormat).toBe('jpeg');
      expect(usage.entries).toEqual([result.usage]);
      expect(result.usage).toMatchObject({ sdk: 'ai-sdk', modelId: MUSE_IMAGE, images: 1 });
      expect(result.usage.estimatedCostUsd).toBeCloseTo(0.01, 10);
    },
    LIVE_TIMEOUT_MS,
  );
});
