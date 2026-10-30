import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  cassetteBlobDir,
  cassettePath,
  describeRequest,
  EXTERNAL_BLOB_MIN_LENGTH,
  FIXTURE_FORMAT_VERSION,
  FixtureError,
  interactionFromResponse,
  META_FIXTURES_DIR,
  readCassette,
  responseFromInteraction,
  writeCassette,
  type Cassette,
} from './fixtures.ts';

const URL_BASE = 'https://api.meta.ai/v1/responses';

function jsonRequest(body: string, url: string = URL_BASE): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

function multipartRequest(): Request {
  const form = new FormData();
  form.append('model', 'muse-voice-transcribe-1.0');
  form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'a.wav');
  // Each Request serialization picks a fresh random boundary.
  return new Request('https://api.meta.ai/v1/asr/transcribe', { method: 'POST', body: form });
}

describe('describeRequest', () => {
  it('ignores JSON key order and whitespace', async () => {
    const a = await describeRequest(jsonRequest('{"model":"m","input":[1,2],"x":{"b":1,"a":2}}'));
    const b = await describeRequest(
      jsonRequest('{ "x": { "a": 2, "b": 1 }, "input": [1, 2], "model": "m" }'),
    );
    expect(a).toEqual(b);
    expect(a).toMatchObject({ method: 'POST', path: '/v1/responses' });
  });

  it('distinguishes different bodies, array order, and query strings', async () => {
    const base = await describeRequest(jsonRequest('{"input":[1,2]}'));
    expect(await describeRequest(jsonRequest('{"input":[2,1]}'))).not.toEqual(base);
    expect(
      (await describeRequest(jsonRequest('{"input":[1,2]}', `${URL_BASE}?b=2&a=1`))).path,
    ).toBe('/v1/responses?a=1&b=2');
  });

  it('is stable across multipart boundaries', async () => {
    const first = multipartRequest();
    const second = multipartRequest();
    expect(first.headers.get('content-type')).not.toBe(second.headers.get('content-type'));
    expect(await describeRequest(first)).toEqual(await describeRequest(second));
  });

  it('can match chosen file fields by name and type instead of content', async () => {
    const transcribeRequest = (
      audio: Uint8Array,
      fileName: string,
      keywords: string[],
    ): Request => {
      const form = new FormData();
      const settings = JSON.stringify({ model: 'muse-voice-transcribe-1.0', keywords });
      form.append('request', new Blob([settings], { type: 'application/json' }));
      form.append('audio', new Blob([audio], { type: 'audio/wav' }), fileName);
      return new Request('https://api.meta.ai/v1/asr/transcribe', { method: 'POST', body: form });
    };
    const match = { ignoreFileContentFields: ['audio'] };
    const recorded = await describeRequest(
      transcribeRequest(new Uint8Array([1, 2, 3]), 'p1-04.wav', ['VvE']),
      match,
    );

    // Different audio bytes, same declared name and settings: same key.
    expect(
      await describeRequest(transcribeRequest(new Uint8Array([9]), 'p1-04.wav', ['VvE']), match),
    ).toEqual(recorded);
    // Non-ignored parts (the JSON settings) and the filename still count.
    expect(
      await describeRequest(transcribeRequest(new Uint8Array([9]), 'p1-04.wav', []), match),
    ).not.toEqual(recorded);
    expect(
      await describeRequest(transcribeRequest(new Uint8Array([9]), 'other.wav', ['VvE']), match),
    ).not.toEqual(recorded);
    // Without the option, content is part of the key.
    expect(
      await describeRequest(transcribeRequest(new Uint8Array([9]), 'p1-04.wav', ['VvE'])),
    ).not.toEqual(
      await describeRequest(transcribeRequest(new Uint8Array([1, 2, 3]), 'p1-04.wav', ['VvE'])),
    );
  });

  it('can key data-URL images by a stable name instead of their bytes', async () => {
    const body = (image: Buffer, prompt = 'segment'): string =>
      JSON.stringify({
        model: 'sam-3.1',
        input: [
          {
            content: [
              { type: 'input_text', text: prompt },
              {
                type: 'input_image',
                image_url: `data:image/jpeg;base64,${image.toString('base64')}`,
              },
            ],
          },
        ],
      });
    const armBytes = Buffer.from('jpeg bytes as encoded on arm64');
    const x86Bytes = Buffer.from('jpeg bytes as encoded on x86-64');
    const names = new Map([
      [createHash('sha256').update(armBytes).digest('hex'), 'photo:source-1'],
      [createHash('sha256').update(x86Bytes).digest('hex'), 'photo:source-1'],
    ]);
    const match = { imageAlias: (sha256: string) => names.get(sha256) };

    // Same source, different re-encoded bytes: same key.
    expect(await describeRequest(jsonRequest(body(x86Bytes)), match)).toEqual(
      await describeRequest(jsonRequest(body(armBytes)), match),
    );
    // The rest of the body still counts, and unnamed images are keyed by their bytes.
    expect(await describeRequest(jsonRequest(body(armBytes, 'other')), match)).not.toEqual(
      await describeRequest(jsonRequest(body(armBytes)), match),
    );
    const unnamed = Buffer.from('an image nobody named');
    expect(await describeRequest(jsonRequest(body(unnamed)), match)).toEqual(
      await describeRequest(jsonRequest(body(unnamed))),
    );
    // Without the option, image bytes are part of the key.
    expect(await describeRequest(jsonRequest(body(x86Bytes)))).not.toEqual(
      await describeRequest(jsonRequest(body(armBytes))),
    );
  });

  it('lets the caller learn image names when a request arrives', async () => {
    const image = Buffer.from('an upload that was stored after the replay started');
    const names = new Map<string, string>();
    const match = {
      imageAlias: (sha256: string) => names.get(sha256),
      beforeImageAlias: async () => {
        await Promise.resolve();
        names.set(createHash('sha256').update(image).digest('hex'), 'photo:late');
      },
    };
    const body = JSON.stringify({
      image_url: `data:image/jpeg;base64,${image.toString('base64')}`,
    });
    const named = JSON.stringify({ image_url: 'image-alias:image/jpeg:photo:late' });
    // Without the hook the image is keyed by its bytes; with it, by the name it learned.
    expect(await describeRequest(jsonRequest(body))).not.toEqual(
      await describeRequest(jsonRequest(named)),
    );
    expect(await describeRequest(jsonRequest(body), match)).toEqual(
      await describeRequest(jsonRequest(named)),
    );
  });

  it('rejects a body that claims JSON but is not', async () => {
    await expect(describeRequest(jsonRequest('{not json'))).rejects.toThrow(FixtureError);
  });
});

describe('interactions', () => {
  it('round-trips a JSON response and keeps only allow-listed headers', async () => {
    const descriptor = await describeRequest(jsonRequest('{}'));
    const interaction = await interactionFromResponse(
      descriptor,
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-request-id': 'r' },
      }),
    );
    expect(interaction.response).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { type: 'json', value: { ok: true } },
    });
    const replayed = responseFromInteraction(interaction);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual({ ok: true });
  });

  it('stores binary bodies as base64', async () => {
    const descriptor = await describeRequest(jsonRequest('{}'));
    const interaction = await interactionFromResponse(
      descriptor,
      new Response(new Uint8Array([0, 255, 7]), { headers: { 'content-type': 'image/png' } }),
    );
    expect(interaction.response.body).toEqual({ type: 'base64', value: 'AP8H' });
    const bytes = new Uint8Array(await responseFromInteraction(interaction).arrayBuffer());
    expect([...bytes]).toEqual([0, 255, 7]);
  });
});

describe('cassettePath', () => {
  it('accepts nested lowercase names and rejects traversal', () => {
    expect(cassettePath('p1-01/spark-text', '/fx')).toBe(path.join('/fx', 'p1-01/spark-text.json'));
    expect(() => cassettePath('../secrets', '/fx')).toThrow(FixtureError);
    expect(() => cassettePath('/abs', '/fx')).toThrow(FixtureError);
    expect(() => cassettePath('Upper', '/fx')).toThrow(FixtureError);
  });
});

describe('external blobs', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'evidomo-fixtures-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A PNG signature padded past the threshold: canonical base64 that decodes to "image" bytes.
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(EXTERNAL_BLOB_MIN_LENGTH, 7),
  ]);
  const largeBase64 = pngBytes.toString('base64');

  function cassette(value: unknown): Cassette {
    return {
      formatVersion: FIXTURE_FORMAT_VERSION,
      cassette: 'p9/blobs',
      recordedAt: '2026-10-28T00:00:00.000Z',
      interactions: [
        {
          request: { method: 'POST', path: '/v1/images/edits', bodySha256: 'a'.repeat(64) },
          response: {
            status: 200,
            headers: { 'content-type': 'application/json' },
            // Parsed copy: writeCassette must not depend on the caller's object identity.
            body: { type: 'json', value: z.json().parse(structuredClone(value)) },
          },
        },
      ],
    };
  }

  it('stores large base64 strings as files and restores them on read', async () => {
    const file = path.join(dir, 'p9/blobs.json');
    const value = { data: [{ b64_json: largeBase64 }], 'a/b~c': [largeBase64], small: 'abcd' };
    await writeCassette(file, cassette(value));

    const json = await readFile(file, 'utf8');
    expect(json.length).toBeLessThan(2_000);
    const blobs = await readdir(cassetteBlobDir(file));
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(await readFile(path.join(cassetteBlobDir(file), blobs[0] ?? ''))).toEqual(pngBytes);
    expect(JSON.parse(json)).toMatchObject({
      interactions: [
        {
          response: {
            body: {
              externals: [
                { pointer: '/data/0/b64_json', file: blobs[0] },
                { pointer: '/a~1b~0c/0', file: blobs[0] },
              ],
            },
          },
        },
      ],
    });

    const restored = await readCassette(file);
    expect(restored.interactions[0]?.response.body).toEqual({ type: 'json', value });
  });

  it('keeps short or non-canonical base64 inline and removes stale blobs on rewrite', async () => {
    const file = path.join(dir, 'p9/blobs.json');
    await writeCassette(file, cassette({ b64_json: largeBase64 }));
    expect(await readdir(cassetteBlobDir(file))).toHaveLength(1);

    const wrapped = `${largeBase64.slice(0, 76)}\n${largeBase64.slice(76)}`;
    await writeCassette(file, cassette({ b64_json: wrapped }));
    await expect(stat(cassetteBlobDir(file))).rejects.toThrow();
    expect((await readCassette(file)).interactions[0]?.response.body).toEqual({
      type: 'json',
      value: { b64_json: wrapped },
    });
  });

  it('fails loudly when a referenced blob is missing or altered', async () => {
    const file = path.join(dir, 'p9/blobs.json');
    await writeCassette(file, cassette({ b64_json: largeBase64 }));
    const [blob = ''] = await readdir(cassetteBlobDir(file));
    const blobPath = path.join(cassetteBlobDir(file), blob);

    await writeFile(blobPath, Buffer.concat([pngBytes, Buffer.from([1])]));
    await expect(readCassette(file)).rejects.toThrow(/corrupted/);
    await rm(blobPath);
    await expect(readCassette(file)).rejects.toThrow(/missing/);
  });
});

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('recorded fixtures', () => {
  it('are valid cassettes without credentials', async () => {
    const files = await listJsonFiles(META_FIXTURES_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const cassette = await readCassette(file);
      expect(path.relative(META_FIXTURES_DIR, file)).toBe(`${cassette.cassette}.json`);
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toMatch(/authorization|bearer\s|LLM\|\d+\|/i);
    }
  });
});
