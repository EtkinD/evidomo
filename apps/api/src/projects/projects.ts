import type {
  ApiValidationIssue,
  CreateProjectRequest,
  FactFormValue,
  MarketProfile,
  OfficeProfile,
  ProjectDetailResponse,
  ProjectListResponse,
  ReadinessItem,
  ServiceDefinition,
} from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import { deleteProjectMaterial, listMaterials } from '../db/repositories/materials.ts';
import {
  createProject,
  deleteProject as deleteProjectRows,
  getProjectForOwner,
  listProjectsWithCountsForOwner,
  lockProjectForOwner,
  touchProject,
  updateProject,
  type Project,
} from '../db/repositories/projects.ts';
import { hasOpenRunSteps } from '../db/repositories/run-steps.ts';
import {
  createRun,
  listRunsForProject,
  lockRunsForProject,
  type Run,
} from '../db/repositories/runs.ts';
import { DefinitionNotFoundError, type DefinitionRegistry } from '../definitions/loader.ts';
import type { Logger } from '../logger.ts';
import type { RunEngine } from '../runs/engine.ts';
import { projectStoragePrefix, type Storage } from '../storage/storage.ts';
import { captureInputs, type CaptureInputs } from '../upload/process-upload.ts';
import { BudgetExceededError, checkBudget } from '../usage/budget.ts';
import { inputsLocked } from './input-lock.ts';
import { checkFactForm, fieldIssues, type FactFormFieldProblems } from './fact-form.ts';
import {
  ACTIVE_RUN_STATUSES,
  computeReadiness,
  projectDetail,
  projectView,
  runSummary,
} from './views.ts';

// Projects and their inputs for the web app (docs/architecture.md §8 "Project and input API").
// Every operation is scoped to the owner: another user's project is "not found", never
// "forbidden". Writes that depend on the input lock (`inputsLocked`) lock the project row first.

/**
 * The service every web project runs, pinned like the CLI pins its project file's service: the
 * project row has no service column, and runs record the ID and version they used.
 */
export const PROJECT_SERVICE = { id: 'listing-launch', version: 1 } as const;

export type ProjectFailure =
  | { readonly reason: 'not_found' }
  | { readonly reason: 'invalid'; readonly issues: ApiValidationIssue[] }
  | {
      readonly reason: 'invalid_fact_form';
      readonly issues: ApiValidationIssue[];
      readonly fields: FactFormFieldProblems;
    }
  | { readonly reason: 'inputs_locked' }
  | { readonly reason: 'not_ready'; readonly missing: ReadinessItem[] }
  | { readonly reason: 'run_active' }
  | { readonly reason: 'run_in_progress' }
  | { readonly reason: 'daily_budget_reached' };

/** An expected refusal, mapped to an HTTP error by the routes. Messages carry no user data. */
export class ProjectRequestError extends Error {
  override name = 'ProjectRequestError';
  readonly failure: ProjectFailure;

  constructor(failure: ProjectFailure) {
    super(`Project request refused: ${failure.reason}`);
    this.failure = failure;
  }
}

export interface ProjectServiceDeps {
  /** The pool-backed database: run starts and locked writes open their own transactions. */
  readonly db: Executor;
  readonly storage: Storage;
  readonly logger: Logger;
  readonly definitions: Pick<DefinitionRegistry, 'getMarket' | 'getService'>;
  /** Run starts enqueue the first step; project deletion discards the runs' pending jobs. */
  readonly engine: Pick<RunEngine, 'startRun' | 'discardPendingJobs'>;
  /** `DAILY_BUDGET_USD`, checked before a run is created. */
  readonly dailyCapUsd: string;
}

export interface ProjectService {
  create(ownerId: string, body: CreateProjectRequest): Promise<ProjectDetailResponse>;
  list(ownerId: string): Promise<ProjectListResponse>;
  get(ownerId: string, projectId: string): Promise<ProjectDetailResponse>;
  update(
    ownerId: string,
    projectId: string,
    changes: { title?: string | undefined; officeProfile?: OfficeProfile | undefined },
  ): Promise<ProjectDetailResponse>;
  saveFactForm(
    ownerId: string,
    projectId: string,
    values: Readonly<Record<string, FactFormValue | null>>,
  ): Promise<ProjectDetailResponse>;
  deleteMaterial(ownerId: string, projectId: string, materialId: string): Promise<void>;
  /**
   * Hard-deletes the project with every derived row, then its files (P5-04). Refused with
   * `run_in_progress` while a run is queued or running.
   */
  deleteProject(ownerId: string, projectId: string): Promise<void>;
  startRun(ownerId: string, projectId: string): Promise<Run>;
  /** The pinned service definition and what capture takes from it. */
  service(): { definition: ServiceDefinition; capture: CaptureInputs };
}

const notFound = (): ProjectRequestError => new ProjectRequestError({ reason: 'not_found' });

export function createProjectService(deps: ProjectServiceDeps): ProjectService {
  const { db, storage, logger, definitions, engine } = deps;
  // Resolved once, when the app is built: a missing or unusable pinned service fails the boot,
  // not every request.
  const pinned = definitions.getService(PROJECT_SERVICE.id, PROJECT_SERVICE.version);
  const pinnedCapture = captureInputs(pinned);

  function service(): { definition: ServiceDefinition; capture: CaptureInputs } {
    return { definition: pinned, capture: pinnedCapture };
  }

  function marketOf(project: Project): MarketProfile {
    return definitions.getMarket(project.marketProfileId, project.marketProfileVersion);
  }

  async function detail(executor: Executor, project: Project): Promise<ProjectDetailResponse> {
    const { definition, capture } = service();
    return projectDetail({
      project,
      market: marketOf(project),
      service: definition,
      capture,
      materials: await listMaterials(executor, project.id),
      runs: await listRunsForProject(executor, project.id),
    });
  }

  async function ownedProject(ownerId: string, projectId: string): Promise<Project> {
    const project = await getProjectForOwner(db, projectId, ownerId);
    if (project === undefined) throw notFound();
    return project;
  }

  /** Locks the project and refuses when its inputs are locked (`inputsLocked`). */
  async function lockEditable(tx: Executor, ownerId: string, projectId: string): Promise<Project> {
    const project = await lockProjectForOwner(tx, projectId, ownerId);
    if (project === undefined) throw notFound();
    if (inputsLocked(await listRunsForProject(tx, projectId))) {
      throw new ProjectRequestError({ reason: 'inputs_locked' });
    }
    return project;
  }

  /**
   * A list entry's market: a project whose market version the server no longer has keeps its
   * entry, with `name: null`, instead of failing the whole list.
   */
  function listedMarket(project: Project): MarketProfile | undefined {
    try {
      return marketOf(project);
    } catch (error) {
      if (!(error instanceof DefinitionNotFoundError)) throw error;
      logger.warn(
        {
          projectId: project.id,
          market: project.marketProfileId,
          version: project.marketProfileVersion,
        },
        'project market definition is unavailable',
      );
      return undefined;
    }
  }

  return {
    service,

    async create(ownerId, body) {
      let market: MarketProfile;
      try {
        market = definitions.getMarket(body.market.id, body.market.version);
      } catch (error) {
        if (!(error instanceof DefinitionNotFoundError)) throw error;
        throw new ProjectRequestError({
          reason: 'invalid',
          issues: [{ path: ['market'], message: 'Unknown market profile' }],
        });
      }
      if (!market.output_languages.includes(body.outputLanguage)) {
        throw new ProjectRequestError({
          reason: 'invalid',
          issues: [
            {
              path: ['outputLanguage'],
              message: `Not offered by this market (${market.output_languages.join(', ')})`,
            },
          ],
        });
      }
      const project = await createProject(db, {
        ownerId,
        title: body.title,
        officeProfile: body.officeProfile,
        marketProfileId: market.id,
        marketProfileVersion: market.version,
        outputLanguage: body.outputLanguage,
      });
      logger.info({ userId: ownerId, projectId: project.id, market: market.id }, 'project created');
      return detail(db, project);
    },

    async list(ownerId) {
      const { definition } = service();
      const rows = await listProjectsWithCountsForOwner(db, ownerId);
      return {
        projects: rows.map((row) => ({
          ...projectView(row.project, listedMarket(row.project), definition),
          photoCount: row.photoCount,
          hasVoiceMemo: row.voiceMemoCount > 0,
          latestRun: row.latestRun === undefined ? null : runSummary(row.latestRun),
        })),
      };
    },

    async get(ownerId, projectId) {
      return detail(db, await ownedProject(ownerId, projectId));
    },

    async update(ownerId, projectId, changes) {
      const updated = await db.transaction(async (tx) => {
        const project =
          changes.officeProfile === undefined
            ? await lockProjectForOwner(tx, projectId, ownerId)
            : // The creative step reads the office profile (tone, contact block) during a run.
              await lockEditable(tx, ownerId, projectId);
        if (project === undefined) throw notFound();
        return updateProject(tx, projectId, {
          ...(changes.title === undefined ? {} : { title: changes.title }),
          ...(changes.officeProfile === undefined ? {} : { officeProfile: changes.officeProfile }),
        });
      });
      return detail(db, updated);
    },

    async saveFactForm(ownerId, projectId, submitted) {
      const project = await ownedProject(ownerId, projectId);
      const checked = checkFactForm(submitted, marketOf(project));
      if (!checked.ok) {
        throw new ProjectRequestError({
          reason: 'invalid_fact_form',
          fields: checked.fields,
          issues: fieldIssues(checked.fields),
        });
      }
      const saved = await db.transaction(async (tx) => {
        await lockEditable(tx, ownerId, projectId);
        return updateProject(tx, projectId, { factForm: checked.values });
      });
      logger.info(
        { userId: ownerId, projectId, fieldCount: Object.keys(checked.values).length },
        'fact form saved',
      );
      return detail(db, saved);
    },

    async deleteMaterial(ownerId, projectId, materialId) {
      const deleted = await db.transaction(async (tx) => {
        await lockEditable(tx, ownerId, projectId);
        const removed = await deleteProjectMaterial(tx, projectId, materialId);
        // A deletion leaves no row behind: the project's `updated_at` records it, so a failed run
        // created before it is no longer resumable (`projectChangedSinceRun`).
        if (removed !== undefined) await touchProject(tx, projectId);
        return removed;
      });
      if (deleted === undefined) throw notFound();
      // After the commit: the row is gone either way, and a file without a row is harmless,
      // while a row without its file would break the next run.
      try {
        await storage.delete(deleted.storageKey);
      } catch (error) {
        logger.error(
          { err: error, storageKey: deleted.storageKey },
          'could not delete a removed material file',
        );
      }
      logger.info({ userId: ownerId, projectId, materialId }, 'material deleted');
    },

    async deleteProject(ownerId, projectId) {
      const deleted = await db.transaction(async (tx) => {
        // Project, then its runs: the order run starts use. The project lock serializes the
        // deletion with uploads, material deletions, form saves, and run starts; the run locks
        // with gate decisions and the worker, which lock the run only. Whatever committed first
        // is seen here, and whatever waits finds nothing afterwards (404, or `run_missing`).
        const project = await lockProjectForOwner(tx, projectId, ownerId);
        if (project === undefined) throw notFound();
        // From here on the stored ID, never the path parameter: `z.uuid()` accepts upper case,
        // which PostgreSQL matches but storage keys (lower case) never contain.
        const id = project.id;
        const runs = await lockRunsForProject(tx, id);
        const runIds = runs.map((run) => run.id);
        // A queued or running run has a job a worker may be executing, writing files under the
        // project's prefix. A run at a gate, completed, or failed has none (its open attempts
        // were closed when it left `running`); the step check backs that invariant up.
        if (
          runs.some((run) => run.status === 'queued' || run.status === 'running') ||
          (await hasOpenRunSteps(tx, runIds))
        ) {
          throw new ProjectRequestError({ reason: 'run_in_progress' });
        }
        const discardedJobs = await engine.discardPendingJobs(runIds, { tx });
        const { storageKeys } = await deleteProjectRows(tx, id);
        return { projectId: id, storageKeys, runCount: runIds.length, discardedJobs };
      });

      // After the commit (storage is not transactional): the rows are gone either way. A file
      // that cannot be deleted now is logged and left to the operator's orphan sweep
      // (`npm run storage:sweep`). Nothing here may throw, or a committed deletion would
      // answer 500.
      let failedFileCount = 0;
      for (const storageKey of deleted.storageKeys) {
        try {
          await storage.delete(storageKey);
        } catch (error) {
          failedFileCount += 1;
          logger.error({ err: error, storageKey }, 'could not delete a file of a deleted project');
        }
      }
      // Whatever no row referenced (e.g. files of a superseded step execution) and the
      // directories themselves.
      try {
        await storage.deletePrefix(projectStoragePrefix(deleted.projectId));
      } catch (error) {
        logger.error(
          { err: error, projectId: deleted.projectId },
          'could not remove the files of a deleted project',
        );
      }
      logger.info(
        {
          userId: ownerId,
          projectId: deleted.projectId,
          runCount: deleted.runCount,
          fileCount: deleted.storageKeys.length,
          failedFileCount,
          discardedJobs: deleted.discardedJobs,
        },
        'project deleted',
      );
    },

    async startRun(ownerId, projectId) {
      const { definition, capture } = service();
      return db.transaction(async (tx) => {
        // The lock serializes the start with uploads, deletions, form saves, and other starts.
        const project = await lockProjectForOwner(tx, projectId, ownerId);
        if (project === undefined) throw notFound();
        const runs = await listRunsForProject(tx, projectId);
        if (runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
          throw new ProjectRequestError({ reason: 'run_active' });
        }
        const market = marketOf(project);
        const readiness = computeReadiness({
          capture,
          market,
          factForm: project.factForm,
          materials: await listMaterials(tx, projectId),
          runs,
        });
        if (readiness.missing.length > 0) {
          throw new ProjectRequestError({ reason: 'not_ready', missing: readiness.missing });
        }
        try {
          await checkBudget(tx, { dailyCapUsd: deps.dailyCapUsd, now: new Date() });
        } catch (error) {
          if (!(error instanceof BudgetExceededError)) throw error;
          throw new ProjectRequestError({ reason: 'daily_budget_reached' });
        }
        const created = await createRun(tx, {
          projectId,
          serviceId: definition.id,
          serviceVersion: definition.version,
          marketProfileId: market.id,
          marketProfileVersion: market.version,
          outputLanguage: project.outputLanguage,
        });
        if (project.status === 'draft') await updateProject(tx, projectId, { status: 'active' });
        // `queued → running` and the first step's job commit with the run, or not at all.
        const run = await engine.startRun(created.id, { tx });
        logger.info({ userId: ownerId, projectId, runId: run.id }, 'run started');
        return run;
      });
    },
  };
}
