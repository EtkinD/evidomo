import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootDefinitions } from './boot.ts';
import { DEFAULT_DEFINITIONS_DIR } from './loader.ts';

const INVALID_DIR = fileURLToPath(new URL('./__tests__/invalid/', import.meta.url));
const API_SRC = fileURLToPath(new URL('../', import.meta.url));

class ExitCalled extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

function capturingLogger() {
  const lines: { level: number; msg: string }[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === 'object' && parsed !== null && 'level' in parsed && 'msg' in parsed) {
          lines.push({ level: Number(parsed.level), msg: String(parsed.msg) });
        }
      }
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, stream), lines };
}

const exitCodes: number[] = [];
function fakeExit(code: number): never {
  exitCodes.push(code);
  throw new ExitCalled(code);
}

let invalidDir: string;
let incompleteDir: string;

beforeAll(async () => {
  // A copy of the real definitions plus one broken service file.
  invalidDir = await mkdtemp(path.join(tmpdir(), 'evidomo-boot-invalid-'));
  await cp(DEFAULT_DEFINITIONS_DIR, invalidDir, { recursive: true });
  await cp(
    path.join(INVALID_DIR, 'service-unpriced-model.yaml'),
    path.join(invalidDir, 'services/broken.v1.yaml'),
  );
  // Valid files, but a published profile is gone.
  incompleteDir = await mkdtemp(path.join(tmpdir(), 'evidomo-boot-incomplete-'));
  await cp(DEFAULT_DEFINITIONS_DIR, incompleteDir, { recursive: true });
  await rm(path.join(incompleteDir, 'markets/nl.v1.yaml'));
});

afterAll(async () => {
  await rm(invalidDir, { recursive: true, force: true });
  await rm(incompleteDir, { recursive: true, force: true });
});

describe('bootDefinitions', () => {
  it('returns the registry for the repository definitions', async () => {
    const { logger, lines } = capturingLogger();
    const registry = await bootDefinitions({ logger, exit: fakeExit });

    expect(registry.getService('listing-launch', 1).id).toBe('listing-launch');
    expect(lines.map((line) => line.msg)).toEqual(['definitions loaded']);
  });

  it('logs the located error as fatal and exits 1 on an invalid definition', async () => {
    const { logger, lines } = capturingLogger();
    exitCodes.length = 0;

    await expect(bootDefinitions({ dir: invalidDir, logger, exit: fakeExit })).rejects.toThrow(
      ExitCalled,
    );
    expect(exitCodes).toEqual([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe(60); // fatal
    expect(lines[0]?.msg).toContain(
      'services/broken.v1.yaml:11:14: service.steps[0].model: Model "muse-spark-9.9" has no entry in the shared price table',
    );
  });

  it('exits 1 when a published definition is missing', async () => {
    const { logger, lines } = capturingLogger();
    exitCodes.length = 0;

    await expect(bootDefinitions({ dir: incompleteDir, logger, exit: fakeExit })).rejects.toThrow(
      ExitCalled,
    );
    expect(exitCodes).toEqual([1]);
    expect(lines[0]?.msg).toContain('markets/nl.v1.yaml: Required market definition is missing');
  });
});

describe('api and worker processes', () => {
  // The real entry points, so the wiring itself is under test. The database URL points at a
  // closed port: definitions are checked before any connection is attempted.
  it.each(['server.ts', 'worker.ts'])(
    '%s exits non-zero with the located error on an invalid definitions directory',
    (entry) => {
      const result = spawnSync(process.execPath, [path.join(API_SRC, entry)], {
        cwd: API_SRC,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'development',
          LOG_LEVEL: 'info',
          DATABASE_URL: 'postgres://evidomo:unused@127.0.0.1:1/evidomo',
          DEFINITIONS_DIR: invalidDir,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('services/broken.v1.yaml:11:14: service.steps[0].model');
      expect(result.stdout).not.toContain('api listening');
      expect(result.stdout).not.toContain('worker started');
    },
    20_000,
  );
});
