import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { hashPassword } from '../auth/password.ts';
import type { Database } from '../db/client.ts';
import { EmailTakenError } from '../db/errors.ts';
import { listUsageForRun, getRunCostUsd } from '../db/repositories/usage.ts';
import { createUser, getUserByEmail } from '../db/repositories/users.ts';
import { loadDefinitions } from '../definitions/loader.ts';
import { DEMO_OWNER_EMAIL } from '../demo/owner.ts';
import { errorForLog } from '../http/errors.ts';
import type { Logger } from '../logger.ts';
import { cassettePath } from '../meta/fixtures.ts';
import type { Storage } from '../storage/storage.ts';
import { executePipeline } from './execute.ts';
import { loadProject } from './project.ts';

// `npm run demo:seed` (P4-09, docs/architecture.md §11 and §13): one fixture project through the
// real pipeline in fixture mode, written to the configured database and storage, so the run can
// be listed in `DEMO_RUN_IDS` and replayed publicly. Zero model calls: every Meta request is
// answered from the project's cassette through MSW, an unrecorded one fails the run, and any
// other host gets a network error. Rerunnable: the demo owner is reused, and each run is a new
// project and run.

/** Prefix of the per-invocation pg-boss schema (see `seedDemoRun`). */
export const DEMO_SEED_BOSS_SCHEMA_PREFIX = 'pgboss_demo_seed_';
/** Prefix of the per-invocation pg-boss schema of `npm run dev:seed`. */
export const DEV_SEED_BOSS_SCHEMA_PREFIX = 'pgboss_dev_seed_';
const BOSS_SCHEMA_PATTERN = /^pgboss_(demo|dev)_seed_[0-9a-f]{12}$/;

/** The project or the run did not meet the seed's guarantees; nothing should be published. */
export class DemoSeedError extends Error {
  override name = 'DemoSeedError';
}

export interface SeedDemoRunOptions {
  readonly projectDir: string;
  readonly db: Database;
  /** The same database as `db`, for pg-boss. */
  readonly connectionString: string;
  readonly storage: Storage;
  /**
   * `DAILY_BUDGET_USD`. Replayed calls are metered like live ones but left out of the daily
   * total (demo owner, docs §10), so only live spend at the cap can stop a seed.
   */
  readonly dailyCapUsd: string;
  readonly logger: Logger;
  readonly progress: (line: string) => void;
  readonly timeoutMs?: number;
  readonly definitionsDir?: string;
}

export interface DemoSeedResult {
  readonly runId: string;
  readonly projectTitle: string;
  readonly ownerCreated: boolean;
  readonly cassette: string;
  /** Usage ledger rows of the run: each one a call answered from the cassette. */
  readonly calls: number;
  readonly servedFromCassette: number;
  readonly liveRequests: number;
  /** What the replayed calls would have cost live (also what the snapshot shows). */
  readonly costUsd: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** The demo owner, created once with a random password nobody knows (so it can never log in). */
async function ensureDemoOwner(db: Database): Promise<{ id: string; created: boolean }> {
  const existing = await getUserByEmail(db, DEMO_OWNER_EMAIL);
  if (existing !== undefined) return { id: existing.id, created: false };
  try {
    const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
    const user = await createUser(db, { email: DEMO_OWNER_EMAIL, passwordHash });
    return { id: user.id, created: true };
  } catch (error) {
    // A concurrent seed created it first.
    if (!(error instanceof EmailTakenError)) throw error;
    const raced = await getUserByEmail(db, DEMO_OWNER_EMAIL);
    if (raced === undefined) throw error;
    return { id: raced.id, created: false };
  }
}

/** Drops a seed's throwaway pg-boss schema; anything not named like one is refused. */
export async function dropBossSchema(db: Database, schema: string, logger: Logger): Promise<void> {
  // Our own throwaway schema, named by us: the pattern check keeps the raw identifier safe.
  if (!BOSS_SCHEMA_PATTERN.test(schema)) throw new Error('Unexpected seed pg-boss schema');
  try {
    await db.execute(sql.raw(`drop schema if exists "${schema}" cascade`));
  } catch (error) {
    // Harmless leftover (no worker reads it); reported so an operator can drop it by hand.
    logger.error({ err: errorForLog(error), schema }, 'could not drop the seed pg-boss schema');
  }
}

/**
 * Seeds one demo run and returns its ID. Throws `DemoSeedError` (after the run ended) unless the
 * run completed with zero live requests and nothing unmatched; such a run is never served by the
 * demo API, which serves completed runs only.
 *
 * The run's jobs go to a pg-boss schema of this invocation only (`pgboss_demo_seed_<random>`),
 * dropped at the end: the deployment's worker works the default schema with live clients and
 * must never pick up a seed job.
 */
export async function seedDemoRun(options: SeedDemoRunOptions): Promise<DemoSeedResult> {
  const { db, logger, progress } = options;
  const definitions = await loadDefinitions(options.definitionsDir);
  const project = await loadProject(options.projectDir, definitions, (id, version) =>
    definitions.getService(id, version),
  );
  const cassette = project.fixture;
  if (cassette === null) {
    throw new DemoSeedError(`${project.dir} has no "fixture" cassette; the seed replays one`);
  }
  const cassetteFile = cassettePath(cassette, project.fixturesDir);
  try {
    await access(cassetteFile);
  } catch {
    throw new DemoSeedError(`No recorded run at ${cassetteFile}`);
  }

  const owner = await ensureDemoOwner(db);
  const bossSchema = `${DEMO_SEED_BOSS_SCHEMA_PREFIX}${randomBytes(6).toString('hex')}`;
  let execution;
  try {
    execution = await executePipeline({
      project,
      definitions,
      mode: 'fixtures',
      cassette,
      fixturesDir: project.fixturesDir,
      // Never a real key: replay sends its placeholder, and no live client is built.
      apiKey: undefined,
      env: {},
      dailyCapUsd: options.dailyCapUsd,
      logger,
      progress,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      target: {
        db,
        bossConnectionString: options.connectionString,
        bossSchema,
        storage: options.storage,
        ownerId: owner.id,
      },
    });
  } finally {
    await dropBossSchema(db, bossSchema, logger);
  }

  const { run, replay } = execution;
  if (replay === undefined) throw new Error('Fixture mode ran without a replay');
  const usage = await listUsageForRun(db, run.id);
  const result: DemoSeedResult = {
    runId: run.id,
    projectTitle: project.title,
    ownerCreated: owner.created,
    cassette,
    calls: usage.length,
    servedFromCassette: replay.servedFromCassetteCount,
    liveRequests: replay.liveRequestCount,
    costUsd: await getRunCostUsd(db, run.id),
  };
  const problems = [
    ...(run.status === 'completed'
      ? []
      : [
          `run ${run.id} ended ${run.status}: ${run.failureReason ?? execution.scriptFailure ?? '?'}`,
        ]),
    ...(result.liveRequests === 0 ? [] : [`${result.liveRequests} live request(s)`]),
    ...replay.unmatched.map((request) => `unmatched request: ${request}`),
  ];
  if (problems.length > 0) {
    throw new DemoSeedError(`The demo run must not be published:\n- ${problems.join('\n- ')}`);
  }
  return result;
}
