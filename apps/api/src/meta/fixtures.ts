import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
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

/**
 * Large base64 strings in JSON bodies (Muse Image `b64_json`) are stored as separate binary
 * files next to the cassette, so cassettes stay small and the images stay viewable. `pointer` is
 * an RFC 6901 JSON pointer into `value`, where the string is replaced by the file name.
 */
const externalBlobSchema = z.object({
  pointer: z.string().startsWith('/'),
  file: z.string().regex(/^[0-9a-f]{64}\.(webp|png|jpg|bin)$/),
});

const fixtureBodySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('json'),
    value: z.json(),
    externals: z.array(externalBlobSchema).optional(),
  }),
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
export type ExternalBlob = z.infer<typeof externalBlobSchema>;
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

/** Directory holding a cassette's external blobs: `<name>.files/` next to `<name>.json`. */
export function cassetteBlobDir(file: string): string {
  return file.replace(/\.json$/, '.files');
}

/** Strings at least this long that are canonical base64 are stored as external blobs. */
export const EXTERNAL_BLOB_MIN_LENGTH = 16 * 1024;

type JsonValue = z.infer<ReturnType<typeof z.json>>;

function pointerToken(key: string | number): string {
  return String(key).replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointerTokens(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** Decoded bytes if `value` is canonical base64 (re-encoding yields the identical string). */
function canonicalBase64Bytes(value: string): Buffer | undefined {
  if (value.length < EXTERNAL_BLOB_MIN_LENGTH || value.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : undefined;
}

function blobExtension(bytes: Uint8Array): 'webp' | 'png' | 'jpg' | 'bin' {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  return 'bin';
}

/** Copies `value`, moving large base64 strings out into `blobs` (file name → bytes). */
function externalize(
  value: JsonValue,
  pointer: string,
  externals: ExternalBlob[],
  blobs: Map<string, Uint8Array>,
): JsonValue {
  if (typeof value === 'string') {
    const bytes = canonicalBase64Bytes(value);
    if (bytes === undefined) return value;
    const file = `${sha256(bytes)}.${blobExtension(bytes)}`;
    externals.push({ pointer, file });
    blobs.set(file, bytes);
    return file;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => externalize(item, `${pointer}/${index}`, externals, blobs));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        externalize(item, `${pointer}/${pointerToken(key)}`, externals, blobs),
      ]),
    );
  }
  return value;
}

/** Replaces the string at `pointer` (which must equal `expected`) with `replacement`, in place. */
function replaceAtPointer(
  root: JsonValue,
  pointer: string,
  expected: string,
  replacement: string,
): boolean {
  const tokens = pointerTokens(pointer);
  const last = tokens.pop();
  if (last === undefined) return false;
  let node: JsonValue = root;
  for (const token of tokens) {
    if (Array.isArray(node)) node = node[Number(token)] ?? null;
    else if (typeof node === 'object' && node !== null && Object.hasOwn(node, token))
      node = node[token] ?? null;
    else return false;
  }
  if (Array.isArray(node)) {
    const index = Number(last);
    if (node[index] !== expected) return false;
    node[index] = replacement;
    return true;
  }
  if (typeof node === 'object' && node !== null && node[last] === expected) {
    node[last] = replacement;
    return true;
  }
  return false;
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

export interface MatchOptions {
  /**
   * Multipart file fields matched by filename and content type only, not by content. Lets a
   * cassette recorded from a local-only input (e.g. TTS audio we may not commit) replay with a
   * stand-in file of the same declared name. The filename becomes the fixture key, so it must be
   * fixed by the test. Default: none (every file is matched by its SHA-256).
   */
  readonly ignoreFileContentFields?: readonly string[];
}

/**
 * Hash of the request body that ignores formatting differences: JSON is canonicalized, and
 * multipart bodies are reduced to their fields (the random boundary would otherwise change the
 * hash on every request). Other bodies are hashed byte for byte.
 */
export async function normalizedBodyHash(
  request: Request,
  options: MatchOptions = {},
): Promise<string> {
  const ignoredFileFields = new Set(options.ignoreFileContentFields ?? []);
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const fields: Array<[string, string | { name: string; type: string; sha256?: string }]> = [];
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') {
        fields.push([name, value]);
      } else if (ignoredFileFields.has(name)) {
        fields.push([name, { name: value.name, type: value.type }]);
      } else {
        fields.push([
          name,
          {
            name: value.name,
            type: value.type,
            sha256: sha256(new Uint8Array(await value.arrayBuffer())),
          },
        ]);
      }
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
export async function describeRequest(
  request: Request,
  options: MatchOptions = {},
): Promise<RequestDescriptor> {
  const url = new URL(request.url);
  url.searchParams.sort();
  return {
    method: request.method.toUpperCase(),
    path: `${url.pathname}${url.search}`,
    bodySha256: await normalizedBodyHash(request, options),
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
  const blobDir = cassetteBlobDir(file);
  for (const interaction of parsed.data.interactions) {
    const { body } = interaction.response;
    if (body.type !== 'json' || body.externals === undefined) continue;
    for (const external of body.externals) {
      let bytes: Buffer;
      try {
        bytes = await readFile(path.join(blobDir, external.file));
      } catch (error) {
        throw new FixtureError(`Meta API fixture ${file}: blob ${external.file} is missing`, {
          cause: error,
        });
      }
      if (`${sha256(bytes)}.${blobExtension(bytes)}` !== external.file) {
        throw new FixtureError(`Meta API fixture ${file}: blob ${external.file} is corrupted`);
      }
      if (
        !replaceAtPointer(body.value, external.pointer, external.file, bytes.toString('base64'))
      ) {
        throw new FixtureError(
          `Meta API fixture ${file}: ${external.pointer} does not reference ${external.file}`,
        );
      }
    }
    // Replay sees the original body, exactly as recorded.
    delete body.externals;
  }
  return parsed.data;
}

/**
 * Writes a cassette, storing large base64 strings as blobs in `<name>.files/`. Blobs left over
 * from an earlier recording of the same cassette are removed.
 */
export async function writeCassette(file: string, cassette: Cassette): Promise<void> {
  const validated = cassetteSchema.parse(cassette);
  const blobs = new Map<string, Uint8Array>();
  const interactions = validated.interactions.map((interaction): Interaction => {
    const { body } = interaction.response;
    if (body.type !== 'json') return interaction;
    const externals: ExternalBlob[] = [];
    const value = externalize(body.value, '', externals, blobs);
    return {
      ...interaction,
      response: {
        ...interaction.response,
        body: externals.length === 0 ? { type: 'json', value } : { type: 'json', value, externals },
      },
    };
  });

  await mkdir(path.dirname(file), { recursive: true });
  const blobDir = cassetteBlobDir(file);
  let existing: string[] = [];
  try {
    existing = await readdir(blobDir);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (blobs.size > 0) await mkdir(blobDir, { recursive: true });
  for (const [name, bytes] of blobs) {
    await writeFile(path.join(blobDir, name), bytes);
  }
  for (const name of existing) {
    if (!blobs.has(name)) await rm(path.join(blobDir, name));
  }
  if (blobs.size === 0 && existing.length > 0) await rmdir(blobDir);
  await writeFile(file, `${JSON.stringify({ ...validated, interactions }, null, 2)}\n`, 'utf8');
}
