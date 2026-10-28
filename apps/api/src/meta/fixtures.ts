import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** Repository-level fixture directory (architecture §3). */
export const META_FIXTURES_DIR = path.resolve(import.meta.dirname, '../../../../fixtures/meta');

export const FIXTURE_FORMAT_VERSION = 1;

/**
 * Only these response headers are stored. Everything else (cookies, request IDs, rate-limit
 * counters, content-encoding/length that no longer match the stored body) is dropped.
 */
export const STORED_RESPONSE_HEADERS = ['content-type'] as const;

const requestDescriptorSchema = z.object({
  method: z.string().min(1),
  /** URL path plus query string, e.g. `/v1/responses`. */
  path: z.string().startsWith('/'),
  /** SHA-256 of the normalized request body (see `normalizedBodyHash`). */
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const fixtureBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('json'), value: z.json() }),
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('base64'), value: z.base64() }),
  z.object({ type: z.literal('empty') }),
]);

const interactionSchema = z.object({
  request: requestDescriptorSchema,
  response: z.object({
    status: z.number().int().min(200).max(299),
    headers: z.record(z.string(), z.string()),
    body: fixtureBodySchema,
  }),
});

const cassetteSchema = z.object({
  formatVersion: z.literal(FIXTURE_FORMAT_VERSION),
  cassette: z.string().min(1),
  recordedAt: z.iso.datetime(),
  interactions: z.array(interactionSchema),
});

export type RequestDescriptor = z.infer<typeof requestDescriptorSchema>;
export type FixtureBody = z.infer<typeof fixtureBodySchema>;
export type Interaction = z.infer<typeof interactionSchema>;
export type Cassette = z.infer<typeof cassetteSchema>;

export class FixtureError extends Error {
  override name = 'FixtureError';
}

const CASSETTE_NAME = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

export function cassettePath(name: string, fixturesDir: string = META_FIXTURES_DIR): string {
  if (!CASSETTE_NAME.test(name)) {
    throw new FixtureError(
      `Invalid cassette name "${name}": use lowercase path segments such as "p1-01/spark-text"`,
    );
  }
  return path.join(fixturesDir, `${name}.json`);
}

/** Recursively sorts object keys so semantically equal JSON bodies hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Hash of the request body that ignores formatting differences: JSON is canonicalized, and
 * multipart bodies are reduced to their fields (the random boundary would otherwise change the
 * hash on every request). Other bodies are hashed byte for byte.
 */
export async function normalizedBodyHash(request: Request): Promise<string> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const fields: Array<[string, string | { name: string; type: string; sha256: string }]> = [];
    for (const [name, value] of form.entries()) {
      fields.push([
        name,
        typeof value === 'string'
          ? value
          : {
              name: value.name,
              type: value.type,
              sha256: sha256(new Uint8Array(await value.arrayBuffer())),
            },
      ]);
    }
    return sha256(canonicalJson(fields));
  }
  const text = await request.text();
  if (contentType.includes('json') && text !== '') {
    try {
      return sha256(canonicalJson(JSON.parse(text)));
    } catch (error) {
      throw new FixtureError(
        `Request to ${request.url} declares JSON but its body is not valid JSON`,
        { cause: error },
      );
    }
  }
  return sha256(text);
}

/** Describes a request for matching. Consumes the body: pass a clone if it is still needed. */
export async function describeRequest(request: Request): Promise<RequestDescriptor> {
  const url = new URL(request.url);
  url.searchParams.sort();
  return {
    method: request.method.toUpperCase(),
    path: `${url.pathname}${url.search}`,
    bodySha256: await normalizedBodyHash(request),
  };
}

export function matchKey(descriptor: RequestDescriptor): string {
  return `${descriptor.method} ${descriptor.path} ${descriptor.bodySha256}`;
}

export async function interactionFromResponse(
  request: RequestDescriptor,
  response: Response,
): Promise<Interaction> {
  const headers: Record<string, string> = {};
  for (const name of STORED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const contentType = headers['content-type'] ?? '';
  const bytes = new Uint8Array(await response.arrayBuffer());
  let body: FixtureBody;
  if (bytes.byteLength === 0) {
    body = { type: 'empty' };
  } else if (contentType.includes('json')) {
    body = { type: 'json', value: z.json().parse(JSON.parse(new TextDecoder().decode(bytes))) };
  } else if (contentType.startsWith('text/')) {
    body = { type: 'text', value: new TextDecoder().decode(bytes) };
  } else {
    body = { type: 'base64', value: Buffer.from(bytes).toString('base64') };
  }
  return { request, response: { status: response.status, headers, body } };
}

export function responseFromInteraction(interaction: Interaction): Response {
  const { status, headers, body } = interaction.response;
  let payload: string | Uint8Array<ArrayBuffer> | null;
  switch (body.type) {
    case 'json':
      payload = JSON.stringify(body.value);
      break;
    case 'text':
      payload = body.value;
      break;
    case 'base64':
      payload = new Uint8Array(Buffer.from(body.value, 'base64'));
      break;
    case 'empty':
      payload = null;
      break;
    default: {
      const exhaustive: never = body;
      throw new FixtureError(`Unknown fixture body type: ${JSON.stringify(exhaustive)}`);
    }
  }
  return new Response(payload, { status, headers });
}

export async function readCassette(file: string): Promise<Cassette> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    throw new FixtureError(
      `Meta API fixture ${file} could not be read. Record it with RECORD=1 (docs/model-notes.md, P1-01).`,
      { cause: error },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new FixtureError(`Meta API fixture ${file} is not valid JSON`, { cause: error });
  }
  const parsed = cassetteSchema.safeParse(json);
  if (!parsed.success) {
    throw new FixtureError(
      `Meta API fixture ${file} has an invalid format:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export async function writeCassette(file: string, cassette: Cassette): Promise<void> {
  const validated = cassetteSchema.parse(cassette);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
}
