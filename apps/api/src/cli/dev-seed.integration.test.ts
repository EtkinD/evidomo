import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXPORT_MANIFEST_ARTIFACT_KIND } from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listArtifacts } from '../db/repositories/artifacts.ts';
import { getProject } from '../db/repositories/projects.ts';
import { getRun } from '../db/repositories/runs.ts';
import { getRunCostUsd, listUsageForRun } from '../db/repositories/usage.ts';
import { createUser } from '../db/repositories/users.ts';
import { startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import { createClaimAuditGate } from '../gates/claim-audit.ts';
import { createFactConflictsGate } from '../gates/fact-conflicts.ts';
import { createLogger } from '../logger.ts';
import { createRunEngine } from '../runs/engine.ts';
import { waitFor } from '../runs/testing.ts';
import { createLocalStorage } from '../storage/local.ts';
import type { Storage } from '../storage/storage.ts';
import { BudgetExceededError, checkBudget } from '../usage/budget.ts';
import { planClaimAuditDecisions, planFactConflictDecisions } from './decisions.ts';
import {
  DEV_REPLAY_DAILY_CAP_USD,
  OwnerNotFoundError,
  ProductionRefusedError,
  seedDevRun,
  type DevSeedResult,
  type DevStopPoint,
} from './dev-seed-run.ts';
import { loadProject } from './project.ts';
import { startReplayWorker } from './replay-worker.ts';

// `npm run dev:seed` and `npm run dev:worker:replay` end to end (docs/architecture.md §5
// "Development seed"), on Testcontainers PostgreSQL standing in for the local database: each stop
// point leaves the run where it should be for the given account, with zero live requests; a run
// left at Gate 1 is then decided through the real gate services (as the API does, enqueueing in
// the default pg-boss schema) and carried to completion by the replay worker alone. Needs Docker
// and ffmpeg.

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const DEMO_PROJECT = path.join(REPO_ROOT, 'fixtures/projects/synthetic-walkthrough');
const logger = createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' });
const OWNER_EMAIL = 'dev-seed-owner@example.test';
const RUN_TIMEOUT_MS = 280_000;

let testDb: TestDatabase;
let storage: Storage;
let storageDir: string;
let definitions: DefinitionRegistry;
let ownerId: string;
let connectionString: string;

function seed(
  stopAt: DevStopPoint,
  overrides: { ownerEmail?: string } = {},
): Promise<DevSeedResult> {
  return seedDevRun({
    projectDir: DEMO_PROJECT,
    ownerEmail: overrides.ownerEmail ?? OWNER_EMAIL,
    stopAt,
    db: testDb.db,
    connectionString,
    storage,
    logger,
    progress: () => undefined,
    nodeEnv: 'test',
  });
}

/** Rows of the tables a seed writes, for "nothing happened" assertions. */
async function rowCounts(): Promise<Record<string, number>> {
  const result = await testDb.db.execute<Record<string, string>>(sql`
    select
      (select count(*) from projects) as projects,
      (select count(*) from runs) as runs,
      (select count(*) from materials) as materials,
      (select count(*) from users) as users`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('no counts');
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

async function seedBossSchemas(): Promise<string[]> {
  const result = await testDb.db.execute<{ schema_name: string }>(
    sql`select schema_name from information_schema.schemata where schema_name like 'pgboss_dev_seed_%'`,
  );
  return result.rows.map((row) => row.schema_name);
}

function expectNoLiveCalls(result: DevSeedResult): void {
  expect(result.liveRequests).toBe(0);
  expect(result.calls).toBeGreaterThan(0);
  expect(result.servedFromCassette).toBe(result.calls);
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  connectionString = testDb.container.getConnectionUri();
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-dev-seed-'));
  storage = createLocalStorage({ rootDir: storageDir });
  definitions = await loadDefinitions();
  // The account is registered in the web app in real use; never a usable password here.
  ownerId = (await createUser(testDb.db, { email: OWNER_EMAIL, passwordHash: 'not-a-real-hash' }))
    .id;
});

afterAll(async () => {
  await testDb?.stop();
  if (storageDir !== undefined) await rm(storageDir, { recursive: true, force: true });
});

describe('dev:seed refusals', () => {
  it('refuses NODE_ENV=production before touching anything', async () => {
    const before = await rowCounts();
    await expect(seedDevRun({ ...baseOptions(), nodeEnv: 'production' })).rejects.toBeInstanceOf(
      ProductionRefusedError,
    );
    expect(await rowCounts()).toEqual(before);
    expect(await seedBossSchemas()).toEqual([]);
  });

  it('refuses production in both entry points, before reading the environment', () => {
    for (const entry of ['dev-seed.ts', 'dev-worker.ts']) {
      const result = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'apps/api/src/cli', entry), '--owner', OWNER_EMAIL],
        // No DATABASE_URL: the refusal must come first.
        { env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'production' }, encoding: 'utf8' },
      );
      expect(result.status, entry).toBe(2);
      expect(result.stderr, entry).toMatch(
        /development tool and refuses to run with NODE_ENV=production/,
      );
    }
  });

  it('exits with an error that says to register first when the account does not exist', async () => {
    const before = await rowCounts();
    const missing = 'nobody-registered@example.test';
    await expect(seed('gate1', { ownerEmail: missing })).rejects.toThrow(OwnerNotFoundError);
    await expect(seed('gate1', { ownerEmail: missing })).rejects.toThrow(
      /Register it in the web app/,
    );

    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'apps/api/src/cli/dev-seed.ts'), '--owner', missing],
      {
        env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test', DATABASE_URL: connectionString },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`No account with the email ${missing}`);
    expect(result.stderr).toContain('Register it in the web app first');
    expect(result.stdout).toBe('');
    // No account was created, and nothing else was written.
    expect(await rowCounts()).toEqual(before);
  });

  it('rejects a missing --owner', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'apps/api/src/cli/dev-seed.ts')],
      {
        env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test', DATABASE_URL: connectionString },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--owner <email> is required');
  });
});

function baseOptions(): Parameters<typeof seedDevRun>[0] {
  return {
    projectDir: DEMO_PROJECT,
    ownerEmail: OWNER_EMAIL,
    stopAt: 'gate1',
    db: testDb.db,
    connectionString,
    storage,
    logger,
    progress: () => undefined,
    nodeEnv: 'test',
  };
}

describe('dev:seed stop points', () => {
  let gate1: DevSeedResult;

  it(
    'gate1: leaves the run awaiting fact_conflicts with every conflict open',
    async () => {
      gate1 = await seed('gate1');
      expectNoLiveCalls(gate1);
      expect(gate1.status).toBe('awaiting_gate');
      expect(gate1.gate).toBe('fact_conflicts');
      expect(gate1.stopped).toEqual({
        gate: 'fact_conflicts',
        conflictCount: 3,
        conflicts: ['K01 build_year', 'K02 other:bedroom_floor', 'K03 vve_monthly_contribution'],
        scriptedDecisions: [
          'K01 build_year: accept transcript side (1987)',
          'K02 other:bedroom_floor: reject every side (no fact form value)',
          'K03 vve_monthly_contribution: accept form side (175 EUR)',
        ],
      });

      const run = await getRun(testDb.db, gate1.runId);
      expect(run).toMatchObject({ status: 'awaiting_gate', gate: 'fact_conflicts' });
      const project = await getProject(testDb.db, gate1.projectId);
      expect(project?.ownerId).toBe(ownerId);
      expect(run?.projectId).toBe(project?.id);

      // The gate as the owner's API sees it: open, nothing decided.
      const gate = await createFactConflictsGate({
        db: testDb.db,
        engine: { resumeAfterGate: () => Promise.reject(new Error('read-only here')) },
        markets: definitions,
      }).get(ownerId, gate1.runId);
      expect(gate).toMatchObject({ state: 'open', conflictCount: 3, openCount: 3 });
      expect(gate.conflicts.every((c) => c.decision === null)).toBe(true);

      // Steps after the gate have not run.
      const steps = await testDb.db.execute<{ step_id: string }>(
        sql`select step_id from run_steps where run_id = ${gate1.runId} and status = 'completed'`,
      );
      expect(steps.rows.map((r) => r.step_id)).not.toContain('creative');
    },
    RUN_TIMEOUT_MS,
  );

  it('leaves no job in any pg-boss schema a worker could take, and no seed schema behind', async () => {
    expect(await seedBossSchemas()).toEqual([]);
    const defaultSchema = await testDb.db.execute<{ present: boolean }>(
      sql`select to_regclass('pgboss.job') is not null as present`,
    );
    if (defaultSchema.rows[0]?.present === true) {
      const jobs = await testDb.db.execute<{ n: string }>(
        sql`select count(*) as n from pgboss.job where data->>'runId' = ${gate1.runId}`,
      );
      expect(Number(jobs.rows[0]?.n)).toBe(0);
    }
  });

  it('meters replayed calls like live ones, under a cap that cannot stop a replay', async () => {
    // Documented trade-off: a dev account is not the demo owner, so seeded usage counts toward
    // the day's total (the safe direction for live runs in development). The replay tools
    // therefore run under a cap that total cannot reach, so a replay never fails on it.
    const cost = await getRunCostUsd(testDb.db, gate1.runId);
    expect(Number(cost)).toBeGreaterThan(0);
    await expect(
      checkBudget(testDb.db, {
        dailyCapUsd: cost.slice(0, cost.indexOf('.') + 3),
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(
      checkBudget(testDb.db, { dailyCapUsd: DEV_REPLAY_DAILY_CAP_USD, now: new Date() }),
    ).resolves.toBeDefined();
  });

  it(
    'gate2: decides Gate 1 as scripted and waits at claim_audit with nothing decided',
    async () => {
      const result = await seed('gate2');
      expectNoLiveCalls(result);
      expect(result.status).toBe('awaiting_gate');
      expect(result.gate).toBe('claim_audit');
      expect(result.stopped?.gate).toBe('claim_audit');

      const project = await getProject(testDb.db, result.projectId);
      expect(project?.ownerId).toBe(ownerId);

      const engineStub = { resumeAfterGate: () => Promise.reject(new Error('read-only here')) };
      const fact = await createFactConflictsGate({
        db: testDb.db,
        engine: engineStub,
        markets: definitions,
      }).get(ownerId, result.runId);
      expect(fact).toMatchObject({ state: 'released', conflictCount: 3, openCount: 0 });
      expect(fact.conflicts.every((c) => c.decision !== null)).toBe(true);

      const gate = await createClaimAuditGate({
        db: testDb.db,
        engine: engineStub,
        markets: definitions,
      }).get(ownerId, result.runId);
      expect(gate).toMatchObject({ state: 'open', approval: null, approvedPackArtifactId: null });
      // Every flagged claim and every offered image is still open.
      expect(gate.counts.openClaims).toBe(gate.counts.flaggedClaims);
      expect(gate.counts.openImages).toBe(gate.counts.offeredImages);
      expect(gate.openCount).toBe(gate.counts.openClaims + gate.counts.openImages);
      expect(gate.openCount).toBeGreaterThan(0);
      expect(gate.images.every((image) => image.decision === null)).toBe(true);
      expect(result.stopped).toEqual({
        gate: 'claim_audit',
        openClaims: gate.counts.openClaims,
        openImages: gate.counts.openImages,
      });
      expect(
        await listArtifacts(testDb.db, result.runId, { kind: EXPORT_MANIFEST_ARTIFACT_KIND }),
      ).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'completed (the default): both gates decided as scripted, exported',
    async () => {
      const result = await seed('completed');
      expectNoLiveCalls(result);
      expect(result.status).toBe('completed');
      expect(result.gate).toBeNull();
      expect(result.stopped).toBeNull();
      const project = await getProject(testDb.db, result.projectId);
      expect(project?.ownerId).toBe(ownerId);
      expect(
        await listArtifacts(testDb.db, result.runId, { kind: EXPORT_MANIFEST_ARTIFACT_KIND }),
      ).toHaveLength(1);
      const gate = await createClaimAuditGate({
        db: testDb.db,
        engine: { resumeAfterGate: () => Promise.reject(new Error('read-only here')) },
        markets: definitions,
      }).get(ownerId, result.runId);
      expect(gate.state).toBe('released');
      expect(gate.approval).not.toBeNull();
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'continues a run left at Gate 1 through the gate services and the replay worker: zero live calls',
    async () => {
      // What the API process does: a pg-boss in the default schema, the engine, and the gate
      // services. It has no step handlers and no Meta clients: it can only enqueue.
      const apiBoss = new PgBoss({ connectionString, supervise: false, schedule: false });
      await apiBoss.start();
      const engine = createRunEngine({
        db: testDb.db,
        boss: apiBoss,
        registry: definitions,
        logger,
        dailyCapUsd: '5.00',
      });
      const factGate = createFactConflictsGate({ db: testDb.db, engine, markets: definitions });
      const auditGate = createClaimAuditGate({ db: testDb.db, engine, markets: definitions });
      const project = await loadProject(DEMO_PROJECT, definitions, (id, version) =>
        definitions.getService(id, version),
      );
      const worker = await startReplayWorker({
        env: {
          DATABASE_URL: connectionString,
          STORAGE_DIR: storageDir,
          DEFINITIONS_DIR: undefined,
        },
        projectDir: DEMO_PROJECT,
        storage,
        logger,
        nodeEnv: 'test',
      });
      try {
        const awaiting = async (gate: 'claim_audit' | 'completed') =>
          waitFor(
            `the run to reach ${gate}`,
            async () => {
              const run = await getRun(testDb.db, gate1.runId);
              if (run?.status === 'failed') throw new Error(`run failed: ${run.failureReason}`);
              const reached =
                gate === 'completed'
                  ? run?.status === 'completed'
                  : run?.status === 'awaiting_gate' && run.gate === 'claim_audit';
              return reached ? run : undefined;
            },
            { timeoutMs: RUN_TIMEOUT_MS - 20_000, intervalMs: 500 },
          );

        // The user decides Gate 1 as printed by the seed; the last decision resumes the run.
        const open = await factGate.get(ownerId, gate1.runId);
        const plan = planFactConflictDecisions(open, project.decisions.factConflicts);
        let resumed = false;
        for (const decision of plan.decisions) {
          resumed = (
            await factGate.decide(ownerId, gate1.runId, decision.conflictId, decision.request)
          ).resumed;
        }
        expect(resumed).toBe(true);
        // The next step went to the default schema, where only the replay worker is listening.
        await awaiting('claim_audit');

        // Gate 2 decisions are free; the export that follows calls no model.
        const gate2 = await auditGate.get(ownerId, gate1.runId);
        const claimPlan = planClaimAuditDecisions(
          gate2,
          project.decisions.claimAudit,
          new Map(gate2.images.map((image) => [image.materialId, 'photo'])),
        );
        for (const c of claimPlan.claims) {
          await auditGate.decideClaim(ownerId, gate1.runId, c.claimId, c.request);
        }
        for (const i of claimPlan.images) {
          await auditGate.decideImage(ownerId, gate1.runId, i.artifactId, i.request);
        }
        await auditGate.approve(ownerId, gate1.runId);
        const completed = await awaiting('completed');
        expect(completed?.status).toBe('completed');
        expect(
          await listArtifacts(testDb.db, gate1.runId, { kind: EXPORT_MANIFEST_ARTIFACT_KIND }),
        ).toHaveLength(1);

        // Every model call after the gate came from the cassette.
        expect(worker.replay.liveRequestCount).toBe(0);
        expect(worker.replay.unmatched).toEqual([]);
        expect(worker.replay.servedFromCassetteCount).toBeGreaterThan(0);
        const calls = await listUsageForRun(testDb.db, gate1.runId);
        expect(calls.length).toBeGreaterThan(gate1.calls);
      } finally {
        await worker.shutdown();
        await apiBoss.stop({ graceful: false });
      }
    },
    RUN_TIMEOUT_MS * 2,
  );
});
