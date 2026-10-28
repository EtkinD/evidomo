import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { factSourceSchema } from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Material } from '../../db/repositories/materials.ts';
import { NonRetryableStepError } from '../../runs/steps.ts';
import { createLocalStorage } from '../../storage/local.ts';
import { newMaterialStorageKey, type Storage } from '../../storage/storage.ts';
import { readPhoto, selectPhotos, toPhotoFact } from './handler.ts';
import { readSampleBytes } from './testing.ts';

// Photo selection and stored-photo checks of the vision handler (no database, no model).

const projectId = randomUUID();
const runCreatedAt = new Date('2026-10-28T12:00:00Z');
let storageDir: string;
let storage: Storage;

const METADATA = {
  width: 1024,
  height: 682,
  sourceFormat: 'jpeg',
  sourceWidth: 1024,
  sourceHeight: 682,
};

function material(overrides: Partial<Material> = {}): Material {
  return {
    id: randomUUID(),
    projectId,
    kind: 'photo',
    status: 'ready',
    storageKey: newMaterialStorageKey(projectId, 'jpg'),
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
    sha256: '0'.repeat(64),
    metadata: METADATA,
    createdAt: new Date('2026-10-28T11:00:00Z'),
    updatedAt: new Date('2026-10-28T11:00:00Z'),
    ...overrides,
  };
}

async function storedSample(overrides: Partial<Material> = {}): Promise<Material> {
  const stored = await storage.put(
    newMaterialStorageKey(projectId, 'jpg'),
    await readSampleBytes('hallway'),
  );
  return material({
    storageKey: stored.key,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    ...overrides,
  });
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-p2-08-handler-'));
  storage = createLocalStorage({ rootDir: storageDir });
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('selectPhotos', () => {
  it('takes ready photos uploaded before the run, in upload order', () => {
    const first = material();
    const later = material({ createdAt: new Date('2026-10-28T13:00:00Z') });
    const failed = material({ status: 'failed' });
    const memo = material({ kind: 'voice_memo' });
    const second = material();
    expect(selectPhotos([first, later, failed, memo, second], runCreatedAt, 30)).toEqual([
      first,
      second,
    ]);
  });

  it('refuses no photos and more than the service maximum', () => {
    expect(() => selectPhotos([material({ status: 'processing' })], runCreatedAt, 30)).toThrow(
      'The project has no processed photos to inventory',
    );
    expect(() => selectPhotos([material(), material()], runCreatedAt, 1)).toThrow(
      'The project has 2 processed photos; the service accepts at most 1',
    );
  });
});

describe('readPhoto', () => {
  it('reads a stored photo and its header', async () => {
    const photo = await readPhoto(storage, await storedSample());
    expect(photo).toMatchObject({ mediaType: 'image/jpeg', width: 1024, height: 682 });
  });

  it('fails without retry on missing files, bad metadata, and dimension mismatches', async () => {
    await expect(readPhoto(storage, material())).rejects.toThrow('A stored photo file is missing');
    await expect(readPhoto(storage, await storedSample({ metadata: null }))).rejects.toThrow(
      'A photo has no valid processing metadata',
    );
    await expect(
      readPhoto(storage, await storedSample({ metadata: { ...METADATA, width: 2048 } })),
    ).rejects.toThrow('A stored photo does not match its recorded dimensions');
    await expect(
      readPhoto(storage, await storedSample({ sha256: 'f'.repeat(64) })),
    ).rejects.toBeInstanceOf(NonRetryableStepError);
  });
});

describe('toPhotoFact', () => {
  it('cites the inventory artifact only when the observation has masks', () => {
    const artifactId = randomUUID();
    const draft = {
      materialId: randomUUID(),
      key: 'other:window',
      value: 2,
      region: { x: 0.1, y: 0.1, width: 0.5, height: 0.4 },
    };
    const masked = toPhotoFact('vision_inventory', artifactId, { ...draft, hasMask: true });
    const plain = toPhotoFact('vision_inventory', artifactId, { ...draft, hasMask: false });
    expect(factSourceSchema.parse(masked.source)).toMatchObject({ maskArtifactId: artifactId });
    expect(factSourceSchema.parse(plain.source)).not.toHaveProperty('maskArtifactId');
    expect(masked).toMatchObject({ unit: null, basis: null, assertion: 'stated', value: 2 });
  });
});
