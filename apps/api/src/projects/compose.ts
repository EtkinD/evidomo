import type { RequestHandler, Router } from 'express';
import type { UploadLimits } from '@evidomo/shared';
import type { SessionMiddleware } from '../auth/session.ts';
import type { Executor } from '../db/client.ts';
import type { DefinitionRegistry } from '../definitions/loader.ts';
import type { Logger } from '../logger.ts';
import type { RunEngine } from '../runs/engine.ts';
import type { Storage } from '../storage/storage.ts';
import { createMaterialCommitter, createUploadProcessor } from '../upload/process-upload.ts';
import { createUploadTempDir } from '../upload/receive.ts';
import {
  createUploadSlots,
  DEFAULT_UPLOAD_SLOT_LIMITS,
  type UploadSlotLimits,
} from '../upload/slots.ts';
import { createMaterialRouter } from './material-routes.ts';
import { createProjectService } from './projects.ts';
import { createProjectRouter } from './routes.ts';

/** What the project and input routes (P4-02 … P4-04) need beyond the app's own dependencies. */
export interface AppProjectDeps {
  definitions: Pick<DefinitionRegistry, 'markets' | 'getMarket' | 'getService'>;
  /** `DAILY_BUDGET_USD`, checked before a run is started or resumed. */
  dailyCapUsd: string;
  /** Defaults to `UPLOAD_LIMITS`; tests pass small limits. */
  uploadLimits?: UploadLimits;
  /**
   * Directory for upload temp files, verified to be private (owner-only, mode 0700); defaults to
   * a per-process `mkdtemp` directory under the OS temp directory.
   */
  uploadTempDir?: string;
  /** In-flight uploads per user and per process; defaults to 2 and 6. */
  uploadSlots?: UploadSlotLimits;
  /**
   * Access code and run limits (`createRunStartGuards`, P4-10), run before a run starts or a
   * failed run is resumed (`POST /api/runs/:runId/resume`, the same array: shared limits).
   */
  runStartGuards?: readonly RequestHandler[];
}

export interface ProjectApiDeps extends AppProjectDeps {
  db: Executor;
  logger: Logger;
  session: SessionMiddleware;
  storage: Storage;
  engine: Pick<RunEngine, 'startRun' | 'discardPendingJobs'>;
}

/**
 * The `/api/projects` router with its service, upload processor, and material routes. Throws when
 * the pinned service is missing or cannot be captured, so the app fails at startup.
 */
export function createProjectApiRouter(deps: ProjectApiDeps): Router {
  const { db, logger, storage } = deps;
  const projects = createProjectService({
    db,
    storage,
    logger,
    definitions: deps.definitions,
    engine: deps.engine,
    dailyCapUsd: deps.dailyCapUsd,
  });
  const { capture } = projects.service();
  const processUpload = createUploadProcessor({
    storage,
    logger,
    capture,
    committer: createMaterialCommitter(db, capture),
    ...(deps.uploadLimits === undefined ? {} : { limits: deps.uploadLimits }),
  });
  const materials = createMaterialRouter({
    db,
    projects,
    processUpload,
    logger,
    ...(deps.uploadLimits === undefined ? {} : { limits: deps.uploadLimits }),
    tempDir: createUploadTempDir(deps.uploadTempDir),
    slots: createUploadSlots(deps.uploadSlots ?? DEFAULT_UPLOAD_SLOT_LIMITS),
    storage,
  });
  return createProjectRouter({
    projects,
    session: deps.session,
    materials,
    ...(deps.runStartGuards === undefined ? {} : { runStartGuards: deps.runStartGuards }),
  });
}
