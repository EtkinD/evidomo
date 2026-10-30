import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import type { Gate } from '@evidomo/shared';
import type { Database } from '../db/client.ts';
import { getRunCostUsd, listUsageForRun } from '../db/repositories/usage.ts';
import { getUserByEmail, normalizeEmail } from '../db/repositories/users.ts';
import { loadDefinitions } from '../definitions/loader.ts';
import type { Logger } from '../logger.ts';
import { cassettePath } from '../meta/fixtures.ts';
import type { Storage } from '../storage/storage.ts';
import { executePipeline, type StoppedAtGate } from './execute.ts';
import { loadProject } from './project.ts';
import {
  defaultPath,
  factConflictsForPath,
  pathEntries,
  readRecordedPaths,
  recordedPathsFile,
  type RecordedPathsFile,
} from './recorded-paths.ts';
import { DEV_SEED_BOSS_SCHEMA_PREFIX, dropBossSchema } from './seed.ts';

// `npm run dev:seed` (docs/architecture.md §5 "Development seed"): a fixture project through the
// real pipeline in fixture mode for an existing local account, left at a chosen point, so the
// web UI (run monitor, Gate 1, Gate 2, pack viewer) and the E2E tests have real runs to open.
// Zero model calls: every Meta request is answered from the project's cassette through MSW.
//
// Where the run continues from a gate: the seed's own jobs live in a pg-boss schema of this
// invocation (`pgboss_dev_seed_<random>`), dropped at the end, so a running `dev:worker` never
// picks one up and makes a live call. A seeded run waits at a gate with no job queued; the
// decision made through the API enqueues the next step in the default `pgboss` schema, which only
// a worker started with `npm run dev:worker:replay` should be working (`replay-worker.ts`).

export const DEV_STOP_POINTS = ['gate1', 'gate2', 'completed'] as const;
export type DevStopPoint = (typeof DEV_STOP_POINTS)[number];

/**
 * The daily cap the dev tools run under. They make no live call (replay answers every request,
 * and the worker's key is a placeholder), so the cap protects nothing there. It is not `0`, and
 * not skipped: replayed calls are metered like live ones and other dev work may already have
 * filled the real cap, which must not stop a replay.
 */
export const DEV_REPLAY_DAILY_CAP_USD = '9999.99';

const STOP_GATES: Readonly<Record<DevStopPoint, Gate | undefined>> = {
  gate1: 'fact_conflicts',
  gate2: 'claim_audit',
  completed: undefined,
};

/** The seed cannot do what was asked; nothing was left half-done except a run named in the message. */
export class DevSeedError extends Error {
  override name = 'DevSeedError';
}

/** The development tools never run against production configuration. */
export class ProductionRefusedError extends DevSeedError {
  override name = 'ProductionRefusedError';

  constructor(tool: string) {
    super(`${tool} is a development tool and refuses to run with NODE_ENV=production`);
  }
}

export function assertNotProduction(tool: string, nodeEnv: string | undefined): void {
  if (nodeEnv?.trim().toLowerCase() === 'production') throw new ProductionRefusedError(tool);
}

/** No account has this email. Accounts are made in the web app, never by the seed. */
export class OwnerNotFoundError extends DevSeedError {
  override name = 'OwnerNotFoundError';

  constructor(email: string) {
    super(
      `No account with the email ${email}. Register it in the web app first ` +
        '(http://localhost:3000/register), then run the seed again.',
    );
  }
}

export interface SeedDevRunOptions {
  readonly projectDir: string;
  readonly ownerEmail: string;
  readonly stopAt: DevStopPoint;
  readonly db: Database;
  /** The same database as `db`, for pg-boss. */
  readonly connectionString: string;
  readonly storage: Storage;
  readonly logger: Logger;
  readonly progress: (line: string) => void;
  /** `NODE_ENV`; anything but production is accepted. */
  readonly nodeEnv: string | undefined;
  readonly timeoutMs?: number;
  readonly definitionsDir?: string;
  /**
   * For `gate2` and `completed`: decide Gate 1 as this recorded path (`recorded-paths.ts`)
   * instead of the default (the path recorded from the decisions file).
   */
  readonly path?: string;
}

export interface DevSeedResult {
  readonly projectId: string;
  readonly runId: string;
  readonly projectDir: string;
  readonly projectTitle: string;
  readonly ownerEmail: string;
  readonly stopAt: DevStopPoint;
  readonly status: string;
  readonly gate: Gate | null;
  readonly cassette: string;
  /** What waits at the gate; null for `completed`. */
  readonly stopped: StoppedAtGate | null;
  /** The cassette's recorded Gate 1 paths; null when it has no paths file (one scripted path). */
  readonly recordedPaths: RecordedPathsFile | null;
  /** The recorded path Gate 1 was decided by (`gate2`, `completed`); null otherwise. */
  readonly path: string | null;
  /** Usage ledger rows of the run: each one a call answered from the cassette. */
  readonly calls: number;
  readonly servedFromCassette: number;
  readonly liveRequests: number;
  /** What the replayed calls would have cost live. */
  readonly costUsd: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The recorded path a `gate2` or `completed` seed decides Gate 1 by: `requested`, else the
 * default path; null for `gate1` and for a cassette without recorded paths (the decisions file
 * decides, as before). Throws `DevSeedError` for a path that was not recorded.
 */
function choosePath(
  recorded: RecordedPathsFile | null,
  stopAt: DevStopPoint,
  requested: string | undefined,
): string | null {
  if (stopAt === 'gate1') {
    if (requested !== undefined) {
      throw new DevSeedError(
        '--path decides Gate 1, so it applies to --stop-at gate2 or completed',
      );
    }
    return null;
  }
  if (recorded === null) {
    if (requested !== undefined) {
      throw new DevSeedError('--path needs recorded Gate 1 paths; this cassette has none');
    }
    return null;
  }
  const ids = recorded.paths.map((p) => p.id);
  if (requested === undefined) return defaultPath(recorded)?.id ?? null;
  if (!ids.includes(requested)) {
    throw new DevSeedError(
      `Gate 1 path "${requested}" was not recorded; recorded paths: ${ids.join(', ') || 'none'}`,
    );
  }
  return requested;
}

/**
 * Seeds one run for the account with `ownerEmail` and returns where it was left. Throws
 * `DevSeedError` for production, an unknown account, a project without a cassette, or a run that
 * did not end where asked, with zero live requests and nothing unmatched.
 */
export async function seedDevRun(options: SeedDevRunOptions): Promise<DevSeedResult> {
  assertNotProduction('dev:seed', options.nodeEnv);
  const { db, logger, progress, stopAt } = options;

  const owner = await getUserByEmail(db, options.ownerEmail);
  if (owner === undefined) throw new OwnerNotFoundError(normalizeEmail(options.ownerEmail));

  const definitions = await loadDefinitions(options.definitionsDir);
  const project = await loadProject(options.projectDir, definitions, (id, version) =>
    definitions.getService(id, version),
  );
  const cassette = project.fixture;
  if (cassette === null) {
    throw new DevSeedError(`${project.dir} has no "fixture" cassette; the seed replays one`);
  }
  const cassetteFile = cassettePath(cassette, project.fixturesDir);
  try {
    await access(cassetteFile);
  } catch {
    throw new DevSeedError(`No recorded run at ${cassetteFile}`);
  }
  const recordedPaths = (await readRecordedPaths(recordedPathsFile(cassetteFile))) ?? null;
  const path = choosePath(recordedPaths, stopAt, options.path);
  const decisions =
    path === null || recordedPaths === null
      ? project.decisions
      : {
          ...project.decisions,
          factConflicts: factConflictsForPath(pathEntries(recordedPaths.conflicts, path)),
        };

  const bossSchema = `${DEV_SEED_BOSS_SCHEMA_PREFIX}${randomBytes(6).toString('hex')}`;
  let execution;
  try {
    execution = await executePipeline({
      project: { ...project, decisions },
      definitions,
      mode: 'fixtures',
      cassette,
      fixturesDir: project.fixturesDir,
      // Never a real key: replay sends its placeholder, and no live client is built.
      apiKey: undefined,
      env: {},
      dailyCapUsd: DEV_REPLAY_DAILY_CAP_USD,
      logger,
      progress,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(STOP_GATES[stopAt] === undefined ? {} : { stopAtGate: STOP_GATES[stopAt] }),
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
  const result: DevSeedResult = {
    projectId: run.projectId,
    runId: run.id,
    projectDir: project.dir,
    projectTitle: project.title,
    ownerEmail: normalizeEmail(options.ownerEmail),
    stopAt,
    status: run.status,
    gate: run.gate,
    cassette,
    stopped: execution.stoppedAt,
    recordedPaths,
    path,
    calls: usage.length,
    servedFromCassette: replay.servedFromCassetteCount,
    liveRequests: replay.liveRequestCount,
    costUsd: await getRunCostUsd(db, run.id),
  };

  const expectedStatus = stopAt === 'completed' ? 'completed' : 'awaiting_gate';
  const expectedGate = STOP_GATES[stopAt] ?? null;
  const problems = [
    ...(run.status === expectedStatus && run.gate === expectedGate
      ? []
      : [
          `run ${run.id} is ${run.status}${run.gate === null ? '' : ` at ${run.gate}`}, ` +
            `expected ${expectedStatus}${expectedGate === null ? '' : ` at ${expectedGate}`}: ` +
            (run.failureReason ?? execution.scriptFailure ?? 'no reason recorded'),
        ]),
    ...(result.liveRequests === 0 ? [] : [`${result.liveRequests} live request(s)`]),
    ...replay.unmatched.map((request) => `unmatched request: ${request}`),
  ];
  if (problems.length > 0) {
    throw new DevSeedError(`The seeded run is not usable:\n- ${problems.join('\n- ')}`);
  }
  return result;
}
