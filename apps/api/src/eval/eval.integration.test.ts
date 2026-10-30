import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

// `npm run eval` in fixture mode, as a process: one seeded set (planted market-fact conflicts and
// three injected claim defects) through the real pipeline on Testcontainers PostgreSQL, replayed
// from its committed cassette plus the shared demo recording. No model key is passed, so a
// request without a recording could only fail; the report must show zero live requests. Needs
// Docker and ffmpeg (CI installs it).

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const run = promisify(execFile);

/** The parts of report.json this test reads values from (the rest is matched as an object). */
const reportShape = z.object({
  sets: z.array(
    z
      .object({
        usage: z.object({ calls: z.int() }),
        score: z.object({ injections: z.array(z.object({ id: z.string() }).loose()) }).loose(),
      })
      .loose(),
  ),
});

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'evidomo-eval-run-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('npm run eval, fixture mode', () => {
  it('runs a seeded set with zero live requests and scores it against its answer key', async () => {
    const outDir = path.join(scratch, 'report');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      // Testcontainers finds Docker through these when they are set.
      ...(process.env['DOCKER_HOST'] === undefined
        ? {}
        : { DOCKER_HOST: process.env['DOCKER_HOST'] }),
      ...(process.env['TESTCONTAINERS_RYUK_DISABLED'] === undefined
        ? {}
        : { TESTCONTAINERS_RYUK_DISABLED: process.env['TESTCONTAINERS_RYUK_DISABLED'] }),
    };
    const { stdout } = await run(
      process.execPath,
      ['apps/api/src/cli/eval.ts', '--sets', '03-market-facts', '--out', outDir],
      { cwd: REPO_ROOT, env, maxBuffer: 16 * 1024 * 1024 },
    );
    expect(stdout).toContain('Planted conflicts surfaced at Gate 1: 4/4 (100%)');

    expect(await readFile(path.join(outDir, 'report.md'), 'utf8')).toContain(
      '# Seeded-defect eval',
    );
    const report: unknown = JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8'));
    const { sets } = reportShape.parse(report);
    const [set] = sets;
    if (set === undefined || sets.length !== 1) throw new Error('expected one set in the report');
    expect(report).toMatchObject({ mode: 'fixtures', liveSpendUsd: 0 });
    // Zero calls: nothing forwarded, nothing unmatched, every metered call from a cassette.
    expect(set).toMatchObject({
      status: 'completed',
      liveCalls: 0,
      network: { liveRequests: 0, servedFromCassette: set.usage.calls, unmatched: [] },
      draftsSeen: { copy: 1, qa: 1 },
    });
    expect(set.usage.calls).toBeGreaterThan(0);

    // Gate 1 (deterministic in replay): the four planted market facts, decided by code, and the
    // incidental bedroom floor the model raised; the 95 m² stays a basis note.
    expect(set.score).toMatchObject({
      conflicts: [
        { id: 'living-area', caught: true },
        { id: 'energy-label', caught: true },
        { id: 'build-year', caught: true },
        { id: 'vve-contribution', caught: true },
        { id: 'bedroom-floor', caught: true },
      ],
      unexpectedConflicts: [],
      basisNotes: [{ id: 'living-area-95', found: true }],
      // Each injection reached the stored first draft, was flagged in the first audit by the
      // expected check, was revised away, and is absent from the export.
      injections: [
        { id: 'sought-after', status: 'applied', detected: true, detectedBy: ['verifier'] },
        { id: 'about-balcony', status: 'applied', detected: true, detectedBy: ['validator'] },
        { id: 'utilities-included', status: 'applied', detected: true, detectedBy: ['verifier'] },
      ],
    });
    for (const injection of set.score.injections) {
      expect(injection, injection.id).toMatchObject({ final: 'removed', exported: false });
    }
    expect(report).toMatchObject({ totals: { injectionsDetected: { hit: 3, total: 3, rate: 1 } } });
  }, 300_000);
});
