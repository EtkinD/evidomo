import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalStorage } from './local.ts';
import {
  InvalidStorageKeyError,
  isProjectStorageSegment,
  isValidStorageKey,
  newMaterialStorageKey,
  newRunArtifactStorageKey,
  projectStoragePrefix,
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

  it('puts every project file below the project prefix', () => {
    const projectId = randomUUID();
    const prefix = projectStoragePrefix(projectId);
    expect(prefix).toBe(`projects/${projectId}`);
    expect(newMaterialStorageKey(projectId, 'wav').startsWith(`${prefix}/`)).toBe(true);
    expect(newRunArtifactStorageKey(projectId, randomUUID(), 'html').startsWith(`${prefix}/`)).toBe(
      true,
    );
    expect(() => projectStoragePrefix('..')).toThrow(InvalidStorageKeyError);
    expect(isProjectStorageSegment(projectId)).toBe(true);
    expect(isProjectStorageSegment(projectId.toUpperCase())).toBe(false);
    expect(isProjectStorageSegment('readme.txt')).toBe(false);
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

  it('reads an inclusive byte range and reports the stored size', async () => {
    await storage.put('r/x.bin', new TextEncoder().encode('0123456789'));

    expect(await storage.stat('r/x.bin')).toEqual({ sizeBytes: 10 });
    expect(await text(await storage.get('r/x.bin', { range: { start: 2, end: 5 } }))).toBe('2345');
    expect(await text(await storage.get('r/x.bin', { range: { start: 9, end: 9 } }))).toBe('9');
    await expect(storage.get('r/x.bin', { range: { start: 5, end: 4 } })).rejects.toThrow(
      RangeError,
    );
    await expect(storage.get('r/x.bin', { range: { start: -1, end: 4 } })).rejects.toThrow(
      RangeError,
    );
    await expect(storage.stat('r/missing.bin')).rejects.toThrow(StorageNotFoundError);
    await expect(storage.stat('r')).rejects.toThrow(StorageNotFoundError);
  });

  it('lists the segments directly below a prefix, sorted, and nothing for a missing one', async () => {
    await storage.put('projects/b/materials/x.jpg', new Uint8Array([1]));
    await storage.put('projects/a/runs/r/artifacts/y.jpg', new Uint8Array([2]));
    await storage.put('projects/c.bin', new Uint8Array([3]));
    // Not writable through the interface, so never listed.
    await mkdir(path.join(root, 'projects', 'Upper'), { recursive: true });
    await writeFile(path.join(root, 'projects', '.hidden'), 'x');

    expect(await storage.listChildren('projects')).toEqual(['a', 'b', 'c.bin']);
    expect(await storage.listChildren('projects/a')).toEqual(['runs']);
    expect(await storage.listChildren('missing')).toEqual([]);
    expect(await storage.listChildren('projects/c.bin')).toEqual([]);
    await expect(storage.listChildren('../x')).rejects.toThrow(InvalidStorageKeyError);
  });

  it('deletes a whole project prefix, idempotently, and leaves its siblings alone', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await storage.put(`projects/${a}/materials/x.jpg`, new Uint8Array([1]));
    await storage.put(`projects/${a}/runs/r/artifacts/y.jpg`, new Uint8Array([2]));
    await storage.put(`projects/${b}/materials/z.jpg`, new Uint8Array([3]));

    await storage.deletePrefix(projectStoragePrefix(a));
    expect(await storage.exists(`projects/${a}/materials/x.jpg`)).toBe(false);
    expect(await storage.exists(`projects/${a}/runs/r/artifacts/y.jpg`)).toBe(false);
    expect(await storage.listChildren('projects')).toEqual([b]);
    expect(await storage.exists(`projects/${b}/materials/z.jpg`)).toBe(true);
    await expect(storage.deletePrefix(projectStoragePrefix(a))).resolves.toBeUndefined();
  });

  it('refuses to delete any prefix but a single project’s, touching nothing', async () => {
    const id = randomUUID();
    await storage.put(`projects/${id}/materials/x.jpg`, new Uint8Array([1]));
    await storage.put('system/database-binding.json', new Uint8Array([2]));
    for (const prefix of [
      'projects',
      'system',
      'system/database-binding.json',
      `projects/${id}/materials`,
      `projects/${id}/materials/x.jpg`,
      `projects/${id.toUpperCase()}`,
      'projects/not-a-uuid',
      `other/${id}`,
      '../x',
      '',
    ]) {
      await expect(storage.deletePrefix(prefix), prefix).rejects.toThrow(InvalidStorageKeyError);
    }
    expect(await storage.exists(`projects/${id}/materials/x.jpg`)).toBe(true);
    expect(await storage.exists('system/database-binding.json')).toBe(true);
  });

  it('removes a symbolic link below a deleted prefix, never its target', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'evidomo-storage-outside-'));
    const id = randomUUID();
    try {
      await writeFile(path.join(outside, 'keep.txt'), 'keep');
      await mkdir(path.join(root, 'projects', id), { recursive: true });
      await symlink(outside, path.join(root, 'projects', id, 'link'));
      await storage.deletePrefix(projectStoragePrefix(id));
      expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
      expect(await storage.listChildren('projects')).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports the newest modification below a prefix, or nothing when it is empty', async () => {
    const id = randomUUID();
    expect(await storage.lastModified(projectStoragePrefix(id))).toBeUndefined();
    await storage.put(`projects/${id}/materials/old.jpg`, new Uint8Array([1]));
    await storage.put(`projects/${id}/runs/r/artifacts/new.jpg`, new Uint8Array([2]));
    const old = new Date('2020-01-01T00:00:00Z');
    // Everything old except the deepest file: the newest time must come from it.
    for (const relative of [
      `projects/${id}`,
      `projects/${id}/materials`,
      `projects/${id}/materials/old.jpg`,
      `projects/${id}/runs`,
      `projects/${id}/runs/r`,
      `projects/${id}/runs/r/artifacts`,
    ]) {
      await utimes(path.join(root, relative), old, old);
    }
    // From `mtimeMs` like the implementation: `stat().mtime` may round the fractional
    // millisecond the other way, which made this flaky.
    const { mtimeMs } = await stat(path.join(root, `projects/${id}/runs/r/artifacts/new.jpg`));
    expect((await storage.lastModified(projectStoragePrefix(id)))?.getTime()).toBe(
      new Date(mtimeMs).getTime(),
    );
  });

  it('never touches paths outside the root', async () => {
    const outside = path.join(path.dirname(root), `outside-${randomUUID()}`);
    await writeFile(outside, 'secret');
    try {
      const traversal = `../${path.basename(outside)}`;
      await expect(storage.get(traversal)).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.exists(traversal)).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.stat(traversal)).rejects.toThrow(InvalidStorageKeyError);
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
