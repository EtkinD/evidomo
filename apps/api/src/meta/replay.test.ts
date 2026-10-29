import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateText } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMetaClients } from './clients.ts';
import { readCassette } from './fixtures.ts';
import { createMetaReplay, REPLAY_PLACEHOLDER_API_KEY, replayModeFromEnv } from './replay.ts';
import { createInMemoryUsageRecorder } from './usage.ts';

// A local stand-in for the Meta API exercises record mode end to end without spending credit.
const MODEL = 'test-model';
const SECRET = 'test-secret-key-do-not-store';
const FAILING_PROMPT = 'this prompt makes the stub answer 500';

function responsesBody(text: string): unknown {
  return {
    id: `resp_${text.length}`,
    object: 'response',
    created_at: 1_700_000_000,
    status: 'completed',
    model: MODEL,
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: `echo: ${text}`, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 11,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 18,
    },
  };
}

interface StubHit {
  path: string;
  authorization: string | undefined;
}

let stub: Server;
let baseURL: string;
const hits: StubHit[] = [];
let fixturesDir: string;

beforeAll(async () => {
  fixturesDir = await mkdtemp(path.join(tmpdir(), 'evidomo-meta-fixtures-'));
  stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', authorization: req.headers.authorization });
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.includes(FAILING_PROMPT)) {
        res.writeHead(500, { 'content-type': 'application/json', 'x-should-retry': 'false' });
        res.end(JSON.stringify({ error: { message: 'stub failure', type: 'server_error' } }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'session=should-not-be-stored',
        'x-request-id': 'req_should_not_be_stored',
      });
      res.end(JSON.stringify(responsesBody(raw.length > 0 ? 'ok' : 'empty')));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address();
  if (address === null || typeof address === 'string') throw new Error('stub has no TCP address');
  baseURL = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    stub.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(fixturesDir, { recursive: true, force: true });
});

afterEach(() => {
  hits.length = 0;
});

async function callBothSdks(apiKey: string, prompt: string): Promise<[string, string]> {
  const clients = createMetaClients({
    apiKey,
    baseURL,
    maxRetries: 0,
    usage: createInMemoryUsageRecorder(),
  });
  const viaAiSdk = await generateText({
    model: clients.languageModel(MODEL),
    prompt,
    ...clients.aiSdkCallOptions(),
  });
  const viaOpenAI = await clients.captureOpenAIUsage(() =>
    clients.openai.responses.create({ model: MODEL, input: prompt }),
  );
  return [viaAiSdk.text, viaOpenAI.output_text];
}

describe('replayModeFromEnv', () => {
  it('records only when RECORD=1', () => {
    expect(replayModeFromEnv({ RECORD: '1' })).toBe('record');
    expect(replayModeFromEnv({ RECORD: 'true' })).toBe('replay');
    expect(replayModeFromEnv({})).toBe('replay');
  });
});

describe('Meta record/replay', () => {
  it('records both SDKs without secrets, then replays them offline', async () => {
    const recorder = createMetaReplay({
      cassette: 'roundtrip',
      mode: 'record',
      baseURL,
      fixturesDir,
      env: { MODEL_API_KEY: SECRET },
    });
    expect(recorder.apiKey).toBe(SECRET);
    await recorder.start();
    const recorded = await callBothSdks(recorder.apiKey, 'hello');
    await recorder.stop();
    recorder.assertAllMatched();

    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.authorization === `Bearer ${SECRET}`)).toBe(true);

    const file = path.join(fixturesDir, 'roundtrip.json');
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(SECRET);
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text).not.toContain('should-not-be-stored');
    expect(text).not.toContain('req_should_not_be_stored');
    const cassette = await readCassette(file);
    // The SDKs serialize the same prompt differently, so each gets its own interaction.
    expect(cassette.interactions).toHaveLength(2);
    for (const interaction of cassette.interactions) {
      expect(interaction.request).toMatchObject({ method: 'POST', path: '/v1/responses' });
      expect(interaction.response.headers).toEqual({ 'content-type': 'application/json' });
    }

    hits.length = 0;
    const player = createMetaReplay({
      cassette: 'roundtrip',
      mode: 'replay',
      baseURL,
      fixturesDir,
    });
    expect(player.apiKey).toBe(REPLAY_PLACEHOLDER_API_KEY);
    await player.start();
    try {
      const replayed = await callBothSdks(player.apiKey, 'hello');
      expect(replayed).toEqual(recorded);
      expect(hits).toHaveLength(0);
      player.assertAllMatched();
    } finally {
      await player.stop();
    }
  });

  it('fails loudly and without retries on an unmatched request, for both SDKs', async () => {
    const player = createMetaReplay({
      cassette: 'roundtrip',
      mode: 'replay',
      baseURL,
      fixturesDir,
    });
    await player.start();
    try {
      const clients = createMetaClients({
        apiKey: player.apiKey,
        baseURL,
        // Default retries on purpose: the 404 must not be retried by either SDK.
        usage: createInMemoryUsageRecorder(),
      });

      await expect(
        generateText({
          model: clients.languageModel(MODEL),
          prompt: 'a prompt that was never recorded',
          ...clients.aiSdkCallOptions(),
        }),
      ).rejects.toThrow(/No recorded Meta API fixture for POST \/v1\/responses/);
      expect(player.unmatched).toHaveLength(1);

      await expect(
        clients.openai.responses.create({ model: MODEL, input: 'also never recorded' }),
      ).rejects.toThrow(/No recorded Meta API fixture/);
      expect(player.unmatched).toHaveLength(2);

      expect(hits).toHaveLength(0);
      expect(() => player.assertAllMatched()).toThrow(/Unmatched requests/);
    } finally {
      await player.stop();
    }
  });

  it('blocks requests to any other host in replay mode', async () => {
    const player = createMetaReplay({
      cassette: 'roundtrip',
      mode: 'replay',
      baseURL,
      fixturesDir,
    });
    await player.start();
    try {
      await expect(fetch('https://example.com/')).rejects.toThrow();
      expect(player.unmatched).toEqual([
        'Blocked request to a non-Meta host: GET https://example.com/',
      ]);
    } finally {
      await player.stop();
    }
  });

  it('does not store failed live responses', async () => {
    const recorder = createMetaReplay({
      cassette: 'failure',
      mode: 'record',
      baseURL,
      fixturesDir,
      env: { MODEL_API_KEY: SECRET },
    });
    await recorder.start();
    const clients = createMetaClients({
      apiKey: recorder.apiKey,
      baseURL,
      maxRetries: 0,
      usage: createInMemoryUsageRecorder(),
    });
    await expect(
      clients.openai.responses.create({ model: MODEL, input: FAILING_PROMPT }),
    ).rejects.toThrow(/stub failure/);
    await expect(recorder.stop()).rejects.toThrow(/captured no successful responses/);
    await expect(readFile(path.join(fixturesDir, 'failure.json'))).rejects.toThrow(/ENOENT/);
  });

  it('serves included cassettes read-only in both modes and never re-records them', async () => {
    // An earlier step's recording...
    const first = createMetaReplay({
      cassette: 'chain-first',
      mode: 'record',
      baseURL,
      fixturesDir,
      env: { MODEL_API_KEY: SECRET },
    });
    await first.start();
    const firstAnswer = await callBothSdks(first.apiKey, 'first step');
    await first.stop();
    hits.length = 0;

    // ...is served from its file while the later step records live.
    const recorder = createMetaReplay({
      cassette: 'chain-second',
      mode: 'record',
      baseURL,
      fixturesDir,
      env: { MODEL_API_KEY: SECRET },
      include: ['chain-first'],
    });
    await recorder.start();
    expect(await callBothSdks(recorder.apiKey, 'first step')).toEqual(firstAnswer);
    expect(hits).toHaveLength(0);
    await callBothSdks(recorder.apiKey, 'second step, longer');
    expect(hits).toHaveLength(2);
    await recorder.stop();
    recorder.assertAllMatched();
    const second = await readCassette(path.join(fixturesDir, 'chain-second.json'));
    expect(second.interactions).toHaveLength(2);

    hits.length = 0;
    const player = createMetaReplay({
      cassette: 'chain-second',
      mode: 'replay',
      baseURL,
      fixturesDir,
      include: ['chain-first'],
    });
    await player.start();
    try {
      await callBothSdks(player.apiKey, 'first step');
      await callBothSdks(player.apiKey, 'second step, longer');
      player.assertAllMatched();
      expect(hits).toHaveLength(0);
    } finally {
      await player.stop();
    }
  });

  it('extends a recording: serves what the cassette answers, records the rest, keeps only what was used', async () => {
    const first = createMetaReplay({
      cassette: 'extend',
      mode: 'record',
      baseURL,
      fixturesDir,
      env: { MODEL_API_KEY: SECRET },
    });
    await first.start();
    await callBothSdks(first.apiKey, 'kept step');
    await callBothSdks(first.apiKey, 'dropped step');
    expect(first.liveRequestCount).toBe(4);
    await first.stop();
    hits.length = 0;

    const seen: string[] = [];
    const again = createMetaReplay({
      cassette: 'extend',
      mode: 'record',
      baseURL,
      fixturesDir,
      env: { MODEL_API_KEY: SECRET },
      extend: true,
      onInteraction: (interaction) => {
        seen.push(interaction.request.path);
      },
    });
    await again.start();
    await callBothSdks(again.apiKey, 'kept step');
    expect(hits).toHaveLength(0);
    await callBothSdks(again.apiKey, 'new step, longer');
    expect(hits).toHaveLength(2);
    expect([again.liveRequestCount, again.servedFromCassetteCount]).toEqual([2, 2]);
    expect(seen).toHaveLength(4);
    await again.stop();
    // The unused "dropped step" interactions are gone; the kept and new ones remain.
    expect((await readCassette(path.join(fixturesDir, 'extend.json'))).interactions).toHaveLength(
      4,
    );

    // An extend session against a missing cassette starts empty.
    const fresh = createMetaReplay({
      cassette: 'extend-fresh',
      mode: 'record',
      baseURL,
      fixturesDir,
      env: { MODEL_API_KEY: SECRET },
      extend: true,
    });
    await fresh.start();
    await callBothSdks(fresh.apiKey, 'only step');
    await fresh.stop();
    expect(fresh.liveRequestCount).toBe(2);
  });

  it('counts no live requests in replay mode', async () => {
    const player = createMetaReplay({ cassette: 'extend', mode: 'replay', baseURL, fixturesDir });
    await player.start();
    try {
      await callBothSdks(player.apiKey, 'new step, longer');
      expect([player.liveRequestCount, player.servedFromCassetteCount]).toEqual([0, 2]);
      expect(hits).toHaveLength(0);
    } finally {
      await player.stop();
    }
  });

  it('refuses to start replay when the cassette is missing', async () => {
    const player = createMetaReplay({ cassette: 'missing', mode: 'replay', baseURL, fixturesDir });
    await expect(player.start()).rejects.toThrow(/Record it with RECORD=1/);
  });

  it('requires MODEL_API_KEY in record mode', () => {
    expect(() =>
      createMetaReplay({ cassette: 'x', mode: 'record', baseURL, fixturesDir, env: {} }),
    ).toThrow(/MODEL_API_KEY is required when RECORD=1/);
  });
});
