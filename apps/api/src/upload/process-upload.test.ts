import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Material } from '../db/repositories/materials.ts';
import type { Storage, StoredObject } from '../storage/storage.ts';
import type { PreparedMaterial } from './prepare.ts';
import {
  createLimiter,
  createUploadProcessor,
  UploadConflictError,
  type CaptureInputs,
  type MaterialCommitter,
  type ProcessUploadInput,
} from './process-upload.ts';
import { UploadAbortedError } from './receive.ts';

// processUpload's cleanup and commit-outcome rules with a fake committer (the database side) and
// a fake storage; the database path itself is covered by projects.integration.test.ts.

const CAPTURE: CaptureInputs = {
  photos: { min: 10, max: 30, required: true },
  voiceMemo: { maxSeconds: 600, required: true },
};
const projectId = randomUUID();
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'evidomo-process-upload-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function tempFile(): Promise<string> {
  const file = path.join(dir, randomUUID());
  await writeFile(file, 'upload body');
  return file;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, stream), lines };
}

function fakeStorage(options: { failDelete?: boolean } = {}) {
  const puts: string[] = [];
  const deletes: string[] = [];
  const storage: Storage = {
    put(key, body) {
      puts.push(key);
      const sizeBytes = body instanceof Uint8Array ? body.length : 1;
      return Promise.resolve({ key, sizeBytes, sha256: 'a'.repeat(64) } satisfies StoredObject);
    },
    get: () => Promise.reject(new Error('not used')),
    stat: () => Promise.reject(new Error('not used')),
    delete(key) {
      deletes.push(key);
      return options.failDelete === true
        ? Promise.reject(new Error('disk gone'))
        : Promise.resolve();
    },
    exists: () => Promise.resolve(false),
    listChildren: () => Promise.reject(new Error('not used')),
    deletePrefix: () => Promise.reject(new Error('not used')),
    lastModified: () => Promise.reject(new Error('not used')),
  };
  return { storage, puts, deletes };
}

function materialFor(stored: StoredObject): Material {
  const now = new Date();
  return {
    id: randomUUID(),
    projectId,
    kind: 'photo',
    status: 'ready',
    storageKey: stored.key,
    mimeType: 'image/jpeg',
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

const prepared: PreparedMaterial = {
  kind: 'photo',
  data: Buffer.from('jpeg'),
  mimeType: 'image/jpeg',
  extension: 'jpg',
  metadata: {},
};

function committer(overrides: Partial<MaterialCommitter> = {}) {
  const calls = { commit: 0, lookups: 0 };
  const value: MaterialCommitter = {
    commit(input, _prepared, stored) {
      calls.commit += 1;
      return (
        overrides.commit?.(input, _prepared, stored) ??
        Promise.resolve({ material: materialFor(stored), replacedKeys: [] })
      );
    },
    findByStorageKey(key) {
      calls.lookups += 1;
      return overrides.findByStorageKey?.(key) ?? Promise.resolve(undefined);
    },
  };
  return { value, calls };
}

function processorWith(
  deps: {
    storage?: Storage;
    committer?: MaterialCommitter;
    prepare?: (input: ProcessUploadInput) => Promise<PreparedMaterial>;
    maxConcurrent?: number;
  } = {},
) {
  const log = capturingLogger();
  const process = createUploadProcessor({
    storage: deps.storage ?? fakeStorage().storage,
    logger: log.logger,
    capture: CAPTURE,
    committer: deps.committer ?? committer().value,
    prepare: deps.prepare ?? (() => Promise.resolve(prepared)),
    ...(deps.maxConcurrent === undefined ? {} : { maxConcurrent: deps.maxConcurrent }),
  });
  return { process, lines: log.lines };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('processUpload', () => {
  it('stores, commits, deletes the replaced files and the temp file', async () => {
    const { storage, puts, deletes } = fakeStorage();
    const fake = committer({
      commit: (_input, _prepared, stored) =>
        Promise.resolve({ material: materialFor(stored), replacedKeys: ['old/key.wav'] }),
    });
    const { process } = processorWith({ storage, committer: fake.value });
    const tempFilePath = await tempFile();

    const material = await process({ projectId, kind: 'photo', tempFilePath });

    expect(puts).toEqual([material.storageKey]);
    expect(material.storageKey).toMatch(new RegExp(`^projects/${projectId}/materials/.+\\.jpg$`));
    expect(deletes).toEqual(['old/key.wav']);
    expect(await exists(tempFilePath)).toBe(false);
  });

  it('deletes the stored file when the commit fails and no row exists', async () => {
    const { storage, puts, deletes } = fakeStorage();
    const failure = new Error('connection lost');
    const fake = committer({ commit: () => Promise.reject(failure) });
    const { process } = processorWith({ storage, committer: fake.value });
    const tempFilePath = await tempFile();

    expect(await rejectionOf(process({ projectId, kind: 'photo', tempFilePath }))).toBe(failure);
    expect(fake.calls.lookups).toBe(1);
    expect(deletes).toEqual(puts);
    expect(await exists(tempFilePath)).toBe(false);
  });

  it('deletes the stored file without a lookup when the project refuses the upload', async () => {
    const { storage, puts, deletes } = fakeStorage();
    const fake = committer({
      commit: () => Promise.reject(new UploadConflictError('photo_limit_reached')),
    });
    const { process } = processorWith({ storage, committer: fake.value });

    const error = await rejectionOf(
      process({ projectId, kind: 'photo', tempFilePath: await tempFile() }),
    );
    expect(error).toBeInstanceOf(UploadConflictError);
    expect(fake.calls.lookups).toBe(0);
    expect(deletes).toEqual(puts);
  });

  it('keeps the file and succeeds when the commit errored but its row exists', async () => {
    const { storage, deletes } = fakeStorage();
    let committedRow: Material | undefined;
    const fake = committer({
      commit: (_input, _prepared, stored) => {
        committedRow = materialFor(stored);
        return Promise.reject(new Error('connection lost during COMMIT'));
      },
      findByStorageKey: () => Promise.resolve(committedRow),
    });
    const { process, lines } = processorWith({ storage, committer: fake.value });

    const material = await process({ projectId, kind: 'photo', tempFilePath: await tempFile() });
    expect(material).toBe(committedRow);
    expect(deletes).toEqual([]);
    expect(
      lines.some((line) => line['msg'] === 'upload commit reported an error but its row exists'),
    ).toBe(true);
  });

  it('keeps the file when the commit outcome cannot be checked', async () => {
    const { storage, deletes } = fakeStorage();
    const failure = new Error('connection lost during COMMIT');
    const fake = committer({
      commit: () => Promise.reject(failure),
      findByStorageKey: () => Promise.reject(new Error('database down')),
    });
    const { process, lines } = processorWith({ storage, committer: fake.value });
    const tempFilePath = await tempFile();

    expect(await rejectionOf(process({ projectId, kind: 'photo', tempFilePath }))).toBe(failure);
    expect(deletes).toEqual([]);
    expect(await exists(tempFilePath)).toBe(false);
    expect(lines.some((line) => line['level'] === 50)).toBe(true);
  });

  it('stops before processing and storing when the client already left', async () => {
    const { storage, puts } = fakeStorage();
    let prepares = 0;
    const controller = new AbortController();
    controller.abort();
    const { process } = processorWith({
      storage,
      prepare: () => {
        prepares += 1;
        return Promise.resolve(prepared);
      },
    });
    const tempFilePath = await tempFile();

    const error = await rejectionOf(
      process({ projectId, kind: 'photo', tempFilePath, signal: controller.signal }),
    );
    expect(error).toBeInstanceOf(UploadAbortedError);
    expect([prepares, puts.length]).toEqual([0, 0]);
    expect(await exists(tempFilePath)).toBe(false);
  });

  it('removes the stored file when the client leaves during the commit', async () => {
    const { storage, puts, deletes } = fakeStorage();
    const controller = new AbortController();
    const fake = committer({
      commit: (input) => {
        controller.abort();
        return input.signal?.aborted === true
          ? Promise.reject(new UploadAbortedError('aborted'))
          : Promise.reject(new Error('signal not passed'));
      },
    });
    const { process } = processorWith({ storage, committer: fake.value });

    const error = await rejectionOf(
      process({
        projectId,
        kind: 'photo',
        tempFilePath: await tempFile(),
        signal: controller.signal,
      }),
    );
    expect(error).toBeInstanceOf(UploadAbortedError);
    expect(fake.calls.lookups).toBe(0);
    expect(deletes).toEqual(puts);
  });

  it('logs a failed cleanup delete and still reports the original error', async () => {
    const { storage } = fakeStorage({ failDelete: true });
    const failure = new UploadConflictError('inputs_locked');
    const fake = committer({ commit: () => Promise.reject(failure) });
    const { process, lines } = processorWith({ storage, committer: fake.value });

    expect(
      await rejectionOf(process({ projectId, kind: 'photo', tempFilePath: await tempFile() })),
    ).toBe(failure);
    expect(
      lines.find((line) => line['msg'] === 'could not delete uncommitted upload file'),
    ).toMatchObject({
      level: 50,
      storageKey: expect.stringMatching(/^projects\//) as unknown,
    });
  });

  it('processes at most maxConcurrent uploads at once', async () => {
    let active = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const { process } = processorWith({
      maxConcurrent: 1,
      prepare: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        return prepared;
      },
    });
    const uploads = [0, 1, 2].map(async () =>
      process({ projectId, kind: 'photo', tempFilePath: await tempFile() }),
    );
    await expect.poll(() => gates.length).toBe(1);
    for (let released = 0; released < 3; released += 1) {
      await expect.poll(() => gates.length).toBe(released + 1);
      gates[released]?.();
    }
    await Promise.all(uploads);
    expect(peak).toBe(1);
  });
});

describe('createLimiter', () => {
  it('frees the slot when a task fails', async () => {
    const limited = createLimiter(1);
    await expect(limited(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limited(() => Promise.resolve('next'))).resolves.toBe('next');
  });
});
