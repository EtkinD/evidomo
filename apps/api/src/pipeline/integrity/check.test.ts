import { APICallError } from 'ai';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadDefinitions } from '../../definitions/loader.ts';
import { createMetaClients } from '../../meta/clients.ts';
import {
  cassettePath,
  describeRequest,
  matchKey,
  readCassette,
  responseFromInteraction,
  type Interaction,
} from '../../meta/fixtures.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { stagingSettings } from '../staging/stage.ts';
import { sampleStagingStep } from '../staging/testing.ts';
import {
  checkStagedPhoto,
  integritySettings,
  judge,
  runIntegrityChecks,
  type IntegrityDeps,
  type IntegrityJob,
  type IntegritySettings,
  type Restage,
} from './check.ts';
import { DEFAULT_FIXED_ELEMENTS, DEFAULT_INTEGRITY_THRESHOLDS } from './compare.ts';
import {
  draftFromImage,
  INTEGRITY_CASSETTE,
  readSampleImage,
  sampleIntegrityStep,
  sampleOriginal,
  sha256,
  stagedContentFor,
  type SampleEdit,
  type SampleOriginal,
} from './testing.ts';

// Photo-level vs. step-level failures of the integrity core, and the privacy rule. SAM answers
// come from the recorded P1-05/P3-05 responses through a stubbed fetch that can replace any
// one of them with an error or with another recorded answer (no network, no MSW).

const usage = createInMemoryUsageRecorder();
const clients = createMetaClients({
  apiKey: 'k',
  usage,
  estimateCost: createPriceTableCostEstimator(),
  maxRetries: 0,
});
const metered: string[] = [];
const meter = async <T>(modelId: string, call: () => Promise<T>): Promise<T> => {
  metered.push(modelId);
  return call();
};
const recorded = new Map<string, Interaction>();
let settings: IntegritySettings;
let staging: ReturnType<typeof stagingSettings>;

/** Decides a reply per SAM request: `undefined` serves the recording. */
type Fault = (request: { phrase: string; body: string }) => Promise<Response> | undefined;

function serve(fault: Fault = () => undefined): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    const phrase = /"text":"([^"]*)"/.exec(body)?.[1] ?? '';
    const replaced = fault({ phrase, body });
    if (replaced !== undefined) return replaced;
    const interaction = recorded.get(matchKey(await describeRequest(request)));
    if (interaction === undefined) throw new Error(`unrecorded SAM request for "${phrase}"`);
    return responseFromInteraction(interaction);
  });
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

const error = (status: number): Promise<Response> =>
  Promise.resolve(Response.json({ error: { message: 'stubbed', type: 'x' } }, { status }));

beforeAll(async () => {
  for (const name of ['p1-05/sam-integrity', INTEGRITY_CASSETTE]) {
    const cassette = await readCassette(cassettePath(name));
    for (const interaction of cassette.interactions) {
      recorded.set(matchKey(interaction.request), interaction);
    }
  }
  const registry = await loadDefinitions();
  settings = integritySettings(sampleIntegrityStep(registry));
  staging = stagingSettings(sampleStagingStep(registry));
});

afterEach(() => {
  vi.unstubAllGlobals();
  usage.clear();
  metered.length = 0;
});

function deps(restage: Restage = noRetry): IntegrityDeps {
  return { clients, meter, restage, staging };
}

const noRetry: Restage = () => {
  throw new Error('must not retry');
};

async function job(original: SampleOriginal, edit: SampleEdit): Promise<IntegrityJob> {
  const photo = await sampleOriginal(original);
  const bytes = await readSampleImage(edit);
  return {
    original: photo,
    stagedArtifactId: '6c1b6a43-0000-4000-8000-000000000001',
    staged: stagedContentFor(
      { ...photo, sha256: sha256(photo.bytes) },
      draftFromImage(photo, 'furnish_living_room', bytes),
    ),
    stagedBytes: bytes,
  };
}

describe('integritySettings', () => {
  it('maps the v1 definition onto the P1-07 defaults', async () => {
    const service = (await loadDefinitions()).getService('listing-launch', 1);
    const step = service.steps.find((s) => s.agent === 'integrity_checker');
    if (step?.agent !== 'integrity_checker') throw new Error('no integrity step');
    expect(integritySettings(step)).toEqual({
      segmentationModel: 'sam-3.1',
      elements: DEFAULT_FIXED_ELEMENTS,
      thresholds: DEFAULT_INTEGRITY_THRESHOLDS,
      editPrivacyPhrases: ['person'],
    });
  });
});

describe('checkStagedPhoto failures', () => {
  it('keeps the original, without a retry, when SAM rejects the original', async () => {
    const j = await job('living-empty', 'living-empty.edit-add-sofa');
    const original = base64(j.original.bytes);
    serve(({ phrase, body }) =>
      phrase === 'door' && body.includes(original) ? error(400) : undefined,
    );
    const result = await checkStagedPhoto(deps(), settings, j);
    expect(result).toMatchObject({
      outcome: 'fallback_original',
      original: null,
      attempts: [{ status: 'unchecked', attempt: 1, target: 'original', reason: 'rejected_input' }],
    });
    // The edit's calls ran alongside and were metered too: 3 + 4.
    expect(metered).toHaveLength(7);
  });

  it('keeps the original, without a retry, when the edit cannot be segmented', async () => {
    const j = await job('living-empty', 'living-empty.edit-remove-window');
    const edit = base64(j.stagedBytes);
    serve(({ phrase, body }) =>
      phrase === 'person' && body.includes(edit) ? error(422) : undefined,
    );
    const result = await checkStagedPhoto(deps(), settings, j);
    expect(result.outcome).toBe('fallback_original');
    expect(result.original).not.toBeNull();
    expect(result.attempts).toEqual([
      {
        status: 'unchecked',
        attempt: 1,
        stagedArtifactId: j.stagedArtifactId,
        target: 'edit',
        reason: 'rejected_input',
      },
    ]);
  });

  it('propagates errors a step retry can fix and starts no further photo', async () => {
    serve(({ phrase }) => (phrase === 'radiator' ? error(500) : undefined));
    const jobs = await Promise.all([
      job('living-empty', 'living-empty.edit-add-sofa'),
      job('bedroom-empty', 'bedroom-empty.edit-add-bed'),
      job('dining-chairs', 'dining-chairs.edit-replace-chairs'),
    ]);
    const failure = await runIntegrityChecks(deps(), settings, jobs).catch((e: unknown) => e);
    expect(APICallError.isInstance(failure)).toBe(true);
    // Two photos in flight (7 calls each); the third never started.
    expect(metered).toHaveLength(14);
  });

  it('fails an edit in which SAM finds a person, and retries it', async () => {
    const j = await job('living-empty', 'living-empty.edit-add-sofa');
    const edit = base64(j.stagedBytes);
    // Stand-in for a drawn person: the edit's recorded `window` answer (one instance).
    serve(({ phrase, body }) => {
      if (phrase !== 'person' || !body.includes(edit)) return undefined;
      return fetchRecordedAs(body, 'person', 'window');
    });
    let retried = 0;
    const result = await checkStagedPhoto(
      deps(() => {
        retried += 1;
        return Promise.resolve({ ok: false, reason: 'rejected_input' });
      }),
      settings,
      j,
    );
    expect(retried).toBe(1);
    const [first] = result.attempts;
    if (first?.status !== 'checked') throw new Error('not checked');
    expect(first.verdict.passed).toBe(true);
    expect(first.privacy).toEqual({ passed: false, phrases: [{ phrase: 'person', count: 1 }] });
    expect(first.passed).toBe(false);
    expect(result.outcome).toBe('fallback_original');
  });
});

/** The recorded answer to the same image with another phrase (the body differs only there). */
async function fetchRecordedAs(body: string, from: string, to: string): Promise<Response> {
  const swapped = body.replace(`"text":"${from}"`, `"text":"${to}"`);
  const request = new Request('https://api.llama.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: swapped,
  });
  const interaction = recorded.get(matchKey(await describeRequest(request)));
  if (interaction === undefined) throw new Error(`no recorded "${to}" answer`);
  return responseFromInteraction(interaction);
}

describe('judge', () => {
  it('treats a box outside the image as unusable output, not a verdict', () => {
    const image = { width: 100, height: 100, segments: { window: [], door: [], radiator: [] } };
    const outside = {
      ...image,
      segments: {
        ...image.segments,
        window: [{ box: { x0: 0, y0: 0, x1: 120, y1: 50 }, score: 0.9 }],
        person: [],
      },
    };
    expect(judge(settings, image, outside, 1, 'a')).toEqual({
      status: 'unchecked',
      attempt: 1,
      stagedArtifactId: 'a',
      target: 'edit',
      reason: 'invalid_output',
    });
  });
});
