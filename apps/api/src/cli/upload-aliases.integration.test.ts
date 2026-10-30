import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRun } from '../db/repositories/runs.ts';
import { seedProject, seedUser, startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { createLocalStorage } from '../storage/local.ts';
import type { Storage } from '../storage/storage.ts';
import { createFixtureImageAliases } from './image-aliases.ts';
import { ingestPhoto } from './ingest.ts';
import { createUploadPhotoAliaser } from './upload-aliases.ts';

// The development replay worker names photos uploaded through the web app by position
// (docs/architecture.md section 5, "Development seed"). Needs Docker.

const SAMPLES = path.resolve(
  import.meta.dirname,
  '../../../../fixtures/samples/synthetic-interiors',
);
const FILES = ['living-empty.jpg', 'kitchen-cluttered.jpg', 'hallway.jpg'];

let testDb: TestDatabase;
let storage: Storage;
let workDir: string;
let userId: string;
const sourceSha256s: string[] = [];
/** What a browser would upload: the same pictures, re-encoded, so the bytes differ. */
const reencoded: string[] = [];

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function projectWithPhotos(order: readonly number[], { run }: { run: boolean }) {
  const project = await seedProject(testDb.db, userId);
  if (run) {
    await createRun(testDb.db, {
      projectId: project.id,
      serviceId: 'listing-launch',
      serviceVersion: 1,
      marketProfileId: 'nl',
      marketProfileVersion: 1,
      outputLanguage: 'en',
    });
  }
  const stored: Uint8Array[] = [];
  for (const index of order) {
    const file = reencoded[index];
    if (file === undefined) throw new Error('no such sample');
    const photo = await ingestPhoto(testDb.db, storage, project.id, { name: file, path: file });
    stored.push(photo.stored.bytes);
  }
  return stored;
}

function aliaser() {
  const aliases = createFixtureImageAliases();
  const sync = createUploadPhotoAliaser({
    db: testDb.db,
    storage,
    aliases,
    sourceSha256s,
    classificationLongEdgePx: undefined,
  });
  return { aliases, sync };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  workDir = await mkdtemp(path.join(tmpdir(), 'evidomo-upload-aliases-'));
  storage = createLocalStorage({ rootDir: path.join(workDir, 'storage') });
  userId = (await seedUser(testDb.db)).id;
  for (const name of FILES) {
    const source = path.join(SAMPLES, name);
    sourceSha256s.push(sha256Hex(await readFile(source)));
    const copy = path.join(workDir, name);
    await sharp(source).jpeg({ quality: 61 }).toFile(copy);
    reencoded.push(copy);
  }
});

afterAll(async () => {
  await testDb?.stop();
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

describe('createUploadPhotoAliaser', () => {
  // The two tests share one database and run in order: the negative one first, while no
  // qualifying project exists, then the positive one, which proves that the earlier projects
  // (same files, other order or count) did not claim the names.
  it('leaves a project without a run, or with another photo count, unnamed', async () => {
    const noRun = await projectWithPhotos([2, 1, 0], { run: false });
    const twoPhotos = await projectWithPhotos([0, 1], { run: true });
    const { aliases, sync } = aliaser();

    await sync();

    const names = [...noRun, ...twoPhotos].map((bytes) => aliases.alias(sha256Hex(bytes)));
    expect(names.filter((name) => name !== undefined)).toHaveLength(0);
  });

  it('names the photos of a project with a run in progress after the recording, by position', async () => {
    const stored = await projectWithPhotos([0, 1, 2], { run: true });
    const { aliases, sync } = aliaser();
    expect(aliases.alias(sha256Hex(stored[0] ?? new Uint8Array()))).toBeUndefined();

    await sync();

    stored.forEach((bytes, index) => {
      expect(aliases.alias(sha256Hex(bytes))).toBe(`photo:${sourceSha256s[index] ?? ''}`);
    });
  });
});
