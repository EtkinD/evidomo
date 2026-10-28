import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cassettePath,
  describeRequest,
  FixtureError,
  interactionFromResponse,
  META_FIXTURES_DIR,
  readCassette,
  responseFromInteraction,
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
