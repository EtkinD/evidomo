import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalStorage } from './local.ts';
import {
  InvalidStorageKeyError,
  isValidStorageKey,
  newMaterialStorageKey,
  newRunArtifactStorageKey,
  StorageNotFoundError,
  type Storage,
} from './storage.ts';

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

describe('storage keys', () => {
  it.each([
    'projects/3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf/materials/a.jpg',
    'a',
    'artifacts/x_y-z.wav',
  ])('accepts %s', (key) => {
    expect(isValidStorageKey(key)).toBe(true);
  });

  it.each([
    '',
    '../etc/passwd',
    'a/../../b',
    'a/./b',
    '/abs/path',
    'a//b',
    'a/',
    '.tmp/x',
    'a\\..\\b',
    'C:/x',
    'A/upper',
    'a/b\0c',
    'name with space',
    'x'.repeat(600),
  ])('rejects %j', (key) => {
    expect(isValidStorageKey(key)).toBe(false);
  });

  it('generates unique material keys under the project prefix', () => {
    const projectId = randomUUID();
    const first = newMaterialStorageKey(projectId, 'jpg');
    const second = newMaterialStorageKey(projectId, 'jpg');
    expect(first).toMatch(new RegExp(`^projects/${projectId}/materials/[0-9a-f-]{36}\\.jpg$`));
    expect(first).not.toBe(second);
    expect(isValidStorageKey(first)).toBe(true);
  });

  it('refuses a project ID or extension that is not a plain token', () => {
    expect(() => newMaterialStorageKey('../x', 'jpg')).toThrow(InvalidStorageKeyError);
    expect(() => newMaterialStorageKey(randomUUID(), '../jpg')).toThrow(InvalidStorageKeyError);
  });

  it('generates unique run artifact keys under the project prefix', () => {
    const projectId = randomUUID();
    const runId = randomUUID();
    const first = newRunArtifactStorageKey(projectId, runId, 'jpg');
    expect(first).toMatch(
      new RegExp(`^projects/${projectId}/runs/${runId}/artifacts/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(first).not.toBe(newRunArtifactStorageKey(projectId, runId, 'jpg'));
    expect(isValidStorageKey(first)).toBe(true);
    expect(() => newRunArtifactStorageKey(projectId, '../x', 'jpg')).toThrow(
      InvalidStorageKeyError,
    );
  });
});

describe('createLocalStorage', () => {
  let root: string;
  let storage: Storage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'evidomo-storage-'));
    storage = createLocalStorage({ rootDir: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('requires an absolute root', () => {
    expect(() => createLocalStorage({ rootDir: 'relative/dir' })).toThrow(/absolute/);
  });

  it('round-trips a buffer and reports size and SHA-256 of the stored bytes', async () => {
    const body = new TextEncoder().encode('hello storage');
    const stored = await storage.put('projects/p/materials/a.bin', body);

    expect(stored).toEqual({
      key: 'projects/p/materials/a.bin',
      sizeBytes: body.byteLength,
      sha256: sha256(body),
    });
    expect(await storage.exists('projects/p/materials/a.bin')).toBe(true);
    expect(await text(await storage.get('projects/p/materials/a.bin'))).toBe('hello storage');
    expect(await readFile(path.join(root, 'projects/p/materials/a.bin'), 'utf8')).toBe(
      'hello storage',
    );
  });

  it('stores a stream and leaves no temp files behind', async () => {
    const chunks = ['one,', 'two,', 'three'];
    const stored = await storage.put(
      's/stream.txt',
      Readable.from(chunks.map((c) => Buffer.from(c))),
    );

    expect(stored.sizeBytes).toBe(13);
    expect(stored.sha256).toBe(sha256(chunks.join('')));
    expect(await readdir(path.join(root, '.tmp'))).toEqual([]);
  });

  it('writes files readable only by the owner', async () => {
    await storage.put('perm/file.bin', new Uint8Array([1]));
    const mode = (await stat(path.join(root, 'perm/file.bin'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('replaces an existing object atomically', async () => {
    await storage.put('k/v.txt', Buffer.from('old'));
    await storage.put('k/v.txt', Buffer.from('new'));
    expect(await text(await storage.get('k/v.txt'))).toBe('new');
  });

  it('removes the temp file and keeps the old object when the body stream fails', async () => {
    await storage.put('k/keep.txt', Buffer.from('intact'));
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('client went away'));
      },
    });

    await expect(storage.put('k/keep.txt', failing)).rejects.toThrow('client went away');
    expect(await text(await storage.get('k/keep.txt'))).toBe('intact');
    expect(await readdir(path.join(root, '.tmp'))).toEqual([]);
  });

  it('rejects object-mode streams instead of storing stringified values', async () => {
    await expect(storage.put('k/obj', Readable.from([{ a: 1 }]))).rejects.toThrow(TypeError);
    expect(await storage.exists('k/obj')).toBe(false);
  });

  it('deletes idempotently', async () => {
    await storage.put('d/x.bin', new Uint8Array([1, 2, 3]));
    await storage.delete('d/x.bin');
    expect(await storage.exists('d/x.bin')).toBe(false);
    await expect(storage.delete('d/x.bin')).resolves.toBeUndefined();
    await expect(storage.get('d/x.bin')).rejects.toThrow(StorageNotFoundError);
  });

  it('treats a missing key and a directory prefix as absent', async () => {
    await storage.put('dir/file.bin', new Uint8Array([1]));
    expect(await storage.exists('nope')).toBe(false);
    expect(await storage.exists('dir')).toBe(false);
    expect(await storage.exists('dir/file.bin/child')).toBe(false);
    await expect(storage.get('dir')).rejects.toThrow(StorageNotFoundError);
  });

  it('never touches paths outside the root', async () => {
    const outside = path.join(path.dirname(root), `outside-${randomUUID()}`);
    await writeFile(outside, 'secret');
    try {
      const traversal = `../${path.basename(outside)}`;
      await expect(storage.get(traversal)).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.exists(traversal)).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.delete(traversal)).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.put(traversal, Buffer.from('x'))).rejects.toThrow(
        InvalidStorageKeyError,
      );
      expect(await readFile(outside, 'utf8')).toBe('secret');
    } finally {
      await rm(outside, { force: true });
    }
  });
});
