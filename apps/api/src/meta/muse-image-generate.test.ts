import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMetaClients, type MetaClients } from './clients.ts';
import { generateMetaImage } from './images.ts';
import { exportImageResult } from './muse-image-export.ts';
import { createMetaReplay } from './replay.ts';
import { createInMemoryUsageRecorder, createTokenPriceEstimator } from './usage.ts';

// Record (spends 6 x $0.01): RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run
//   --project api muse-image-generate   (docs/model-notes.md, P1-06)
// Default runs replay fixtures/meta/p1-06/generate.json (+ generate.files/).
// The downscaled set in fixtures/samples/synthetic-interiors/ is derived from these outputs.

const MUSE_IMAGE = 'muse-image-1.0';
const LIVE_TIMEOUT_MS = 300_000;

// Keeps generated scenes free of personal data and third-party marks (fixtures are public).
const SCENE_RULES =
  'Photorealistic real-estate listing photograph, eye-level wide-angle shot, soft natural ' +
  'daylight. Strictly no people, no faces, no pets, no mirrors, no glass reflections, no ' +
  'text, no lettering, no logos, no brands, no artwork, no television or screens. Windows ' +
  'show only overcast sky and tree tops: no street, no cars, no neighbouring buildings.';

/** Synthetic Dutch-style interiors; ids become sample file names. */
const SCENES = [
  {
    id: 'living-empty',
    prompt:
      'An empty living room in a 1930s Dutch apartment: light oak plank floor, white walls, ' +
      'one large white-framed window with a white panel radiator directly beneath it, and a ' +
      'closed white panelled interior door on the right wall. No furniture.',
  },
  {
    id: 'living-dining-cluttered',
    prompt:
      'A lightly furnished living and dining room in a Dutch apartment: a wooden dining table ' +
      'covered with clutter (plain unmarked cardboard boxes, loose blank papers, mugs, a fruit ' +
      'bowl, folded towels), two tall white-framed windows with a white panel radiator under ' +
      'each, a closed white interior door on the left wall, light herringbone oak floor.',
  },
  {
    id: 'kitchen-cluttered',
    prompt:
      'A compact Dutch apartment kitchen: white handleless cabinets, a light grey worktop ' +
      'cluttered with plain unwashed dishes, unlabelled jars, a dish rack and a plain kettle, ' +
      'one white-framed window above the sink, a white panel radiator on the side wall, and ' +
      'an open white door to a hallway.',
  },
  {
    id: 'bedroom-empty',
    prompt:
      'An empty bedroom in a Dutch apartment: pale grey carpet, white walls, a white-framed ' +
      'window with a white panel radiator below it, a closed white interior door, and a ' +
      'built-in wardrobe with plain white doors. No furniture.',
  },
  {
    id: 'hallway',
    prompt:
      'A narrow hallway in a Dutch apartment: light oak floor, white walls, three closed white ' +
      'panelled interior doors, a white panel radiator on the side wall, an empty coat rail, ' +
      'and a small frosted window high on the end wall.',
  },
  {
    id: 'dining-chairs',
    prompt:
      'A dining area in a Dutch apartment: a rectangular oak dining table with six dated dark ' +
      'brown wooden chairs with worn green seat cushions, a large white-framed window with a ' +
      'white panel radiator beneath it, a closed white interior door on the right wall, white ' +
      'walls, light oak floor. Otherwise empty.',
  },
] as const;

function scenePrompt(scene: (typeof SCENES)[number]): string {
  return `${scene.prompt} ${SCENE_RULES}`;
}

const replay = createMetaReplay({ cassette: 'p1-06/generate' });
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

describe(`${MUSE_IMAGE} text-to-image (${replay.mode})`, () => {
  it.each(SCENES)(
    'generates $id as one landscape image and records one billed image',
    async (scene) => {
      const result = await generateMetaImage(clients, {
        modelId: MUSE_IMAGE,
        prompt: scenePrompt(scene),
        size: '1536x1024',
      });
      await exportImageResult(scene.id, result, replay.mode, { kind: 'generate' });

      expect(result.images).toHaveLength(1);
      const [image] = result.images;
      // API default output format when none is requested.
      expect(image?.format).toBe('webp');
      expect(result.outputFormat).toBe('webp');
      // Measured (P1-06): `size` 1536x1024 sets the 3:2 aspect ratio; pixels are 1920x1280.
      expect(image).toMatchObject({ width: 1920, height: 1280 });

      expect(usage.entries).toEqual([result.usage]);
      expect(result.usage).toMatchObject({ sdk: 'ai-sdk', modelId: MUSE_IMAGE, images: 1 });
      expect(result.usage.estimatedCostUsd).toBeCloseTo(0.01, 10);
    },
    LIVE_TIMEOUT_MS,
  );
});
