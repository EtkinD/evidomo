import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedProject, seedUser, startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { createLogger } from '../logger.ts';
import { createLocalStorage } from '../storage/local.ts';
import {
  newMaterialStorageKey,
  newRunArtifactStorageKey,
  type Storage,
} from '../storage/storage.ts';
import {
  databaseIdentity,
  findOrphanedProjects,
  STORAGE_BINDING_KEY,
  sweepOrphanedProjectFiles,
  type SweepOptions,
} from './orphan-files.ts';

// The operator's orphaned-file sweep (P5-04, `npm run storage:sweep`) against PostgreSQL (Testcontainers) and local storage in a
// fresh temp directory per test, so every test starts with an unbound storage.

const logger = createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' });
let testDb: TestDatabase;
let ownerId: string;
let root: string;
let storage: Storage;

beforeAll(async () => {
  testDb = await startTestDatabase();
  ownerId = (await seedUser(testDb.db)).id;
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'evidomo-orphans-'));
  storage = createLocalStorage({ rootDir: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Stores a material and a run artifact for `projectId`; returns their keys. */
async function storeFilesFor(projectId: string): Promise<string[]> {
  const keys = [
    newMaterialStorageKey(projectId, 'jpg'),
    newRunArtifactStorageKey(projectId, randomUUID(), 'html'),
  ];
  for (const key of keys) await storage.put(key, new TextEncoder().encode(key));
  return keys;
}

function sweep(options: Partial<SweepOptions> = {}) {
  // Age 0 unless a test is about the age guard: the files were all written just now.
  return sweepOrphanedProjectFiles(
    { db: testDb.db, storage, logger },
    { limit: 100, bind: false, minAgeMs: 0, ...options },
  );
}

async function allExist(keys: readonly string[]): Promise<boolean> {
  for (const key of keys) if (!(await storage.exists(key))) return false;
  return true;
}

/** Backdates everything below `projects/<projectId>` to `when`. */
async function backdate(projectId: string, when: Date): Promise<void> {
  const top = path.join(root, 'projects', projectId);
  const entries = await readdir(top, { recursive: true, withFileTypes: true });
  // Deepest first, so touching a child cannot refresh a parent already backdated.
  const paths = entries.map((entry) => path.join(entry.parentPath, entry.name)).reverse();
  for (const target of [...paths, top]) await utimes(target, when, when);
}

describe('sweepOrphanedProjectFiles', () => {
  it('removes the files of projects that no longer exist, and only those', async () => {
    const live = await seedProject(testDb.db, ownerId);
    const liveKeys = await storeFilesFor(live.id);
    const orphan = randomUUID();
    const orphanKeys = await storeFilesFor(orphan);
    // Names that are not project IDs are never touched.
    await storage.put('projects/readme.txt', new TextEncoder().encode('not a project'));
    await storage.put('other/file.bin', new Uint8Array([1]));

    const result = await sweep({ bind: true });

    expect(result).toMatchObject({
      status: 'swept',
      removedProjectIds: [orphan],
      failedProjectIds: [],
      tooRecentProjectIds: [],
      deferredCount: 0,
      scan: { scannedCount: 2, ignoredCount: 1 },
    });
    for (const key of orphanKeys) expect(await storage.exists(key)).toBe(false);
    expect(await storage.listChildren('projects')).toEqual([live.id, 'readme.txt']);
    expect(await allExist(liveKeys)).toBe(true);
    expect(await storage.exists('other/file.bin')).toBe(true);
    // It recorded which database the storage belongs to; the next sweep needs no --bind.
    const binding: unknown = JSON.parse(await text(await storage.get(STORAGE_BINDING_KEY)));
    expect(binding).toEqual(await databaseIdentity(testDb.db));
    const strayKeys = await storeFilesFor(randomUUID());
    expect(await sweep()).toMatchObject({ status: 'swept' });
    expect(await allExist(strayKeys)).toBe(false);
  });

  it('never binds without --bind: an unbound storage is refused, orphans or not', async () => {
    // Empty storage: nothing could go wrong, and still no silent binding.
    expect(await sweep()).toMatchObject({ status: 'refused', reason: 'unbound' });
    expect(await storage.exists(STORAGE_BINDING_KEY)).toBe(false);

    const keys = (await Promise.all([randomUUID(), randomUUID()].map(storeFilesFor))).flat();
    expect(await sweep()).toMatchObject({ status: 'refused', reason: 'unbound' });
    expect(await allExist(keys)).toBe(true);
    expect(await storage.exists(STORAGE_BINDING_KEY)).toBe(false);
  });

  it('refuses on a storage bound to another database, until the operator binds it', async () => {
    const orphan = randomUUID();
    const keys = await storeFilesFor(orphan);
    const identity = await databaseIdentity(testDb.db);
    await storage.put(
      STORAGE_BINDING_KEY,
      new TextEncoder().encode(JSON.stringify({ ...identity, databaseOid: '1' })),
    );

    expect(await sweep()).toMatchObject({ status: 'refused', reason: 'bound_elsewhere' });
    expect(await allExist(keys)).toBe(true);

    // An unreadable binding is no better than a foreign one.
    await storage.put(STORAGE_BINDING_KEY, new TextEncoder().encode('{not json'));
    expect(await sweep()).toMatchObject({ status: 'refused', reason: 'bound_elsewhere' });

    expect(await sweep({ bind: true })).toMatchObject({
      status: 'swept',
      removedProjectIds: [orphan],
    });
    expect(await allExist(keys)).toBe(false);
  });

  it('lists without deleting or binding in a dry run', async () => {
    const orphan = randomUUID();
    const keys = await storeFilesFor(orphan);

    const result = await sweep({ dryRun: true, bind: true });

    expect(result).toMatchObject({
      status: 'dry_run',
      binding: 'unbound',
      scan: { orphanProjectIds: [orphan] },
    });
    expect(await allExist(keys)).toBe(true);
    expect(await storage.exists(STORAGE_BINDING_KEY)).toBe(false);
  });

  it('skips orphans with anything modified within the minimum age', async () => {
    const [old, fresh] = [randomUUID(), randomUUID()];
    const oldKeys = await storeFilesFor(old);
    const freshKeys = await storeFilesFor(fresh);
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    await backdate(old, new Date(now.getTime() - 2 * dayMs));
    // Old, except one file written an hour ago: the directory counts as recent.
    await backdate(fresh, new Date(now.getTime() - 2 * dayMs));
    const touched = path.join(root, String(freshKeys[1]));
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    await utimes(touched, hourAgo, hourAgo);

    const result = await sweep({ bind: true, minAgeMs: dayMs, now });

    expect(result).toMatchObject({
      status: 'swept',
      removedProjectIds: [old],
      tooRecentProjectIds: [fresh],
    });
    expect(await allExist(oldKeys)).toBe(false);
    expect(await allExist(freshKeys)).toBe(true);
    // The operator's override (`--min-age-hours 0`).
    expect(await sweep({ minAgeMs: 0, now })).toMatchObject({ removedProjectIds: [fresh] });
  });

  it('removes at most `limit` projects and leaves the rest for the next sweep', async () => {
    const orphans = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of orphans) await storeFilesFor(id);

    const first = await sweep({ limit: 2, bind: true });
    expect(first).toMatchObject({ status: 'swept', removedProjectIds: orphans.slice(0, 2) });
    expect(first.status === 'swept' && first.deferredCount).toBe(1);
    expect((await findOrphanedProjects(testDb.db, storage)).orphanProjectIds).toEqual(
      orphans.slice(2),
    );

    const second = await sweep({ limit: 2 });
    expect(second).toMatchObject({ status: 'swept', removedProjectIds: orphans.slice(2) });
    expect(await storage.listChildren('projects')).toEqual([]);
  });

  it('logs a project it cannot remove and goes on with the others', async () => {
    const orphans = [randomUUID(), randomUUID()].sort();
    for (const id of orphans) await storeFilesFor(id);
    const [stuck, removable] = orphans;
    const flaky: Storage = {
      ...storage,
      deletePrefix: (prefix) =>
        prefix.endsWith(String(stuck))
          ? Promise.reject(new Error('disk gone'))
          : storage.deletePrefix(prefix),
    };

    const result = await sweepOrphanedProjectFiles(
      { db: testDb.db, storage: flaky, logger },
      { limit: 100, bind: true, minAgeMs: 0 },
    );

    expect(result).toMatchObject({
      status: 'swept',
      removedProjectIds: [removable],
      failedProjectIds: [stuck],
    });
    expect(await storage.listChildren('projects')).toEqual([stuck]);
  });
});
