import {
  RESUME_REFUSAL_CODES,
  type ApiErrorCode,
  type RunResumability,
  type ServiceDefinition,
} from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import { lockProjectForOwner } from '../db/repositories/projects.ts';
import {
  getRunForOwner,
  listRunsForProject,
  lockRun,
  projectChangedSinceRun,
  type Run,
} from '../db/repositories/runs.ts';
import { DefinitionNotFoundError, type DefinitionRegistry } from '../definitions/loader.ts';
import type { Logger } from '../logger.ts';
import { ACTIVE_RUN_STATUSES } from '../projects/views.ts';
import type { RunEngine } from '../runs/engine.ts';
import { BudgetExceededError, checkBudget, type BudgetCapKind } from '../usage/budget.ts';

// Resuming a failed run from the web app (P5-03, docs/architecture.md §5 "Run API"). The engine's
// `resumeRun` does the state change (`failed → queued → running`, a new attempt of the failed
// step, completed steps skipped). `decideResumability` is the one rule set: the endpoint applies
// it under the same locks as a run start and a project deletion (project, then run), and the run
// snapshot reports it as `resume`, so the two cannot drift apart.

export interface ResumabilityDeps {
  /** The run's definition: its cost cap, and whether the engine can still run it. */
  readonly services: Pick<DefinitionRegistry, 'getService'>;
  /** `DAILY_BUDGET_USD`, checked before a resume like before a start. */
  readonly dailyCapUsd: string;
}

function definitionOf(
  services: Pick<DefinitionRegistry, 'getService'>,
  run: Run,
): ServiceDefinition | undefined {
  try {
    return services.getService(run.serviceId, run.serviceVersion);
  } catch (error) {
    if (error instanceof DefinitionNotFoundError) return undefined;
    throw error;
  }
}

/**
 * Whether `run` (as read in `db`'s transaction) can be resumed, and if not, why. Reads only, so
 * it runs in the snapshot's read-only transaction as well as under the endpoint's locks. Anything
 * but a failed run is decided from the row alone; a failed run costs the project's runs, the
 * run's ledger total, today's ledger total (indexed by `created_at`), and one change check.
 * Permanent reasons come before the daily cap, which passes with the day.
 */
export async function decideResumability(
  db: Executor,
  run: Run,
  { services, dailyCapUsd }: ResumabilityDeps,
): Promise<RunResumability> {
  if (run.status !== 'failed') return 'not_failed';
  const service = definitionOf(services, run);
  if (service === undefined) return 'definition_unavailable';
  // Under the endpoint's project lock no run can become active meanwhile (starts take it too).
  const runs = await listRunsForProject(db, run.projectId);
  if (runs.some((other) => other.id !== run.id && ACTIVE_RUN_STATUSES.includes(other.status))) {
    return 'other_run_active';
  }

  // The ledger's own check, against the run's committed spend: a run whose spend reached its
  // cap would fail on its first model call again, whatever its stored reason says.
  let capReached: BudgetCapKind | undefined;
  try {
    await checkBudget(db, {
      dailyCapUsd,
      run: { runId: run.id, capUsd: service.budget.max_cost_usd_per_run },
      now: new Date(),
    });
  } catch (error) {
    if (!(error instanceof BudgetExceededError)) throw error;
    capReached = error.kind;
  }
  if (capReached === 'run') return 'budget_exhausted';
  // The steps read the project's current inputs. Once every run failed the inputs are editable
  // again, and a resumed run would mix outputs of the old inputs (completed steps) with the new
  // ones (e.g. facts citing a photo deleted since).
  if (await projectChangedSinceRun(db, run.id)) return 'inputs_changed';
  if (capReached === 'daily') return 'daily_budget_reached';
  return 'available';
}

export type RunResumeRefusal = Extract<
  ApiErrorCode,
  'not_found' | 'run_not_resumable' | 'run_active' | 'run_budget_exhausted' | 'daily_budget_reached'
>;

export type RunResumeOutcome =
  | { readonly kind: 'resumed'; readonly run: Run }
  | {
      readonly kind: 'refused';
      readonly reason: RunResumeRefusal;
      /** For the log: the resumability that refused it, or `not_found`. */
      readonly detail: Exclude<RunResumability, 'available'> | 'not_found';
    };

export interface RunResumerDeps extends ResumabilityDeps {
  /** The pool-backed database; each resume runs in its own transaction. */
  readonly db: Executor;
  readonly engine: Pick<RunEngine, 'resumeRun'>;
  readonly logger: Logger;
}

export interface RunResumer {
  /** Resumes the owner's failed run, or says why not. Never throws for a refusal. */
  resume(ownerId: string, runId: string): Promise<RunResumeOutcome>;
}

const NOT_FOUND: RunResumeOutcome = { kind: 'refused', reason: 'not_found', detail: 'not_found' };

export function createRunResumer(deps: RunResumerDeps): RunResumer {
  const { db, engine, logger } = deps;

  async function resumeLocked(
    tx: Executor,
    ownerId: string,
    owned: Run,
  ): Promise<RunResumeOutcome> {
    // Project, then run: the order of run starts and project deletion, so a resume and a deletion
    // serialize instead of deadlocking. Whichever commits first is what the other one sees: a
    // deletion that waited finds a running run (409 `run_in_progress`), a resume that waited
    // finds no project (404).
    const project = await lockProjectForOwner(tx, owned.projectId, ownerId);
    if (project === undefined) return NOT_FOUND;
    // Re-read under the lock: a concurrent resume that committed first left it `running`.
    const run = await lockRun(tx, owned.id);
    if (run === undefined) return NOT_FOUND;
    const resumability = await decideResumability(tx, run, deps);
    if (resumability !== 'available') {
      return { kind: 'refused', reason: RESUME_REFUSAL_CODES[resumability], detail: resumability };
    }
    // The transition and the failed step's new job commit together with these checks.
    return { kind: 'resumed', run: await engine.resumeRun(run.id, { tx }) };
  }

  return {
    async resume(ownerId, runId) {
      // Unlocked, for the project ID only (it never changes); everything that decides the
      // outcome is read again under the locks.
      const owned = await getRunForOwner(db, runId, ownerId);
      const outcome =
        owned === undefined
          ? NOT_FOUND
          : await db.transaction((tx) => resumeLocked(tx, ownerId, owned));
      if (outcome.kind === 'resumed') {
        logger.info(
          { userId: ownerId, projectId: outcome.run.projectId, runId, status: outcome.run.status },
          'run resumed',
        );
      } else {
        logger.info(
          { userId: ownerId, runId, reason: outcome.reason, detail: outcome.detail },
          'run resume refused',
        );
      }
      return outcome;
    },
  };
}
