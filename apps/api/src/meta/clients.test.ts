import { generateText } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertStandardModelId,
  createMetaClients,
  ForbiddenModelError,
  META_BASE_URL,
  MetaConfigError,
} from './clients.ts';
import { createMetaReplay } from './replay.ts';
import { createInMemoryUsageRecorder } from './usage.ts';

const usage = createInMemoryUsageRecorder();

describe('createMetaClients', () => {
  it('fails fast without an API key', () => {
    expect(() => createMetaClients({ apiKey: undefined, usage })).toThrow(MetaConfigError);
    expect(() => createMetaClients({ apiKey: '', usage })).toThrow(MetaConfigError);
  });

  it('points both SDKs at the Meta API with the shared retry and timeout policy', () => {
    const clients = createMetaClients({ apiKey: 'k', usage, maxRetries: 3, timeoutMs: 5_000 });
    expect(clients.openai.baseURL).toBe(META_BASE_URL);
    expect(clients.openai.maxRetries).toBe(3);
    expect(clients.openai.timeout).toBe(5_000);
    expect(clients.languageModel('muse-spark-1.3')).toMatchObject({
      provider: 'meta.responses',
      modelId: 'muse-spark-1.3',
    });
    expect(clients.aiSdkCallOptions()).toMatchObject({ maxRetries: 3, timeout: 5_000 });
  });
});

describe('Standard-mode guard', () => {
  // Network stays blocked here, so a regression in the guard cannot reach the live API.
  const replay = createMetaReplay({ cassette: 'p1-01/spark-text', mode: 'replay' });
  beforeAll(() => replay.start());
  afterAll(() => replay.stop());

  it('rejects Contributor-mode model IDs', () => {
    expect(() => assertStandardModelId('muse-spark-1.3-contributor')).toThrow(ForbiddenModelError);
    expect(() => assertStandardModelId('muse-spark-1.3')).not.toThrow();
  });

  it('blocks Contributor-mode requests from either SDK before they reach the network', async () => {
    const clients = createMetaClients({ apiKey: 'k', usage, maxRetries: 0 });

    expect(() => clients.languageModel('muse-spark-1.3-contributor')).toThrow(ForbiddenModelError);
    await expect(
      generateText({
        model: clients.provider.responses('muse-spark-1.3-contributor'),
        prompt: 'x',
        ...clients.aiSdkCallOptions(),
      }),
    ).rejects.toThrow(ForbiddenModelError);

    // The openai SDK wraps fetch failures in APIConnectionError; the guard is the cause.
    const error: unknown = await clients.openai.responses
      .create({ model: 'muse-spark-1.3-contributor', input: 'x' })
      .then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.cause : undefined).toBeInstanceOf(ForbiddenModelError);
  });
});
