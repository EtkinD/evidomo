import { Router, type RequestHandler, type Response } from 'express';
import {
  createProjectRequestSchema,
  projectParamsSchema,
  putFactFormRequestSchema,
  startRunRequestSchema,
  updateProjectRequestSchema,
  type ApiError,
  type ProjectDetailResponse,
  type ProjectListResponse,
  type StartRunResponse,
} from '@evidomo/shared';
import { currentUser, type SessionMiddleware } from '../auth/session.ts';
import { sendError, sendValidationError } from '../http/errors.ts';
import { requireJsonBody } from '../http/guards.ts';
import { ProjectRequestError, type ProjectService } from './projects.ts';
import { runSummary } from './views.ts';

export interface ProjectRouterDeps {
  readonly projects: ProjectService;
  readonly session: SessionMiddleware;
  /** The material routes (raw upload bodies), mounted before the JSON body guard. */
  readonly materials: Router;
  /**
   * Middleware run before a run is started, after authentication: the access code and the
   * per-account and per-IP run limits (`createRunStartGuards`, P4-10). None when omitted.
   */
  readonly runStartGuards?: readonly RequestHandler[];
}

/** Maps a refusal to its documented status and body (docs/architecture.md §8). */
export function sendProjectError(res: Response, error: ProjectRequestError): void {
  const { failure } = error;
  switch (failure.reason) {
    case 'not_found':
      sendError(res, 404, 'not_found');
      return;
    case 'invalid':
      res
        .status(400)
        .json({ error: 'validation_failed', issues: failure.issues } satisfies ApiError);
      return;
    case 'invalid_fact_form':
      res.status(400).json({
        error: 'validation_failed',
        issues: failure.issues,
        fields: failure.fields,
      } satisfies ApiError);
      return;
    case 'inputs_locked':
      sendError(res, 409, 'inputs_locked');
      return;
    case 'not_ready':
      res.status(409).json({ error: 'not_ready', missing: failure.missing } satisfies ApiError);
      return;
    case 'run_active':
      sendError(res, 409, 'run_active');
      return;
    case 'daily_budget_reached':
      sendError(res, 409, 'daily_budget_reached');
      return;
    default: {
      const unreachable: never = failure;
      throw new Error(`Unhandled project failure ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Mounted at `/api/projects`, every route behind `requireUser` and `Cache-Control: no-store`.
 * A project that does not exist and another user's project both answer 404 `not_found`.
 */
export function createProjectRouter(deps: ProjectRouterDeps): Router {
  const { projects, session } = deps;
  const router = Router();
  router.use(session.requireUser);
  router.use((_req, res, next) => {
    // Responses carry property data: never cached.
    res.set('Cache-Control', 'no-store');
    next();
  });
  // Raw bodies (photos, voice memos) have their own Content-Type allow-list; everything after
  // this line is JSON.
  router.use('/:projectId/materials', deps.materials);
  router.use(requireJsonBody);

  async function respond(res: Response, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof ProjectRequestError)) throw error;
      sendProjectError(res, error);
    }
  }

  router.get('/', async (req, res) => {
    const body = await projects.list(currentUser(req).id);
    res.json(body satisfies ProjectListResponse);
  });

  router.post('/', async (req, res) => {
    const parsed = createProjectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    await respond(res, async () => {
      const body = await projects.create(currentUser(req).id, parsed.data);
      res.status(201).json(body satisfies ProjectDetailResponse);
    });
  });

  router.get('/:projectId', async (req, res) => {
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    await respond(res, async () => {
      const body = await projects.get(currentUser(req).id, params.data.projectId);
      res.json(body satisfies ProjectDetailResponse);
    });
  });

  router.patch('/:projectId', async (req, res) => {
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    const parsed = updateProjectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    await respond(res, async () => {
      const body = await projects.update(currentUser(req).id, params.data.projectId, parsed.data);
      res.json(body satisfies ProjectDetailResponse);
    });
  });

  router.put('/:projectId/fact-form', async (req, res) => {
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    const parsed = putFactFormRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    await respond(res, async () => {
      const body = await projects.saveFactForm(
        currentUser(req).id,
        params.data.projectId,
        parsed.data.values,
      );
      res.json(body satisfies ProjectDetailResponse);
    });
  });

  router.post('/:projectId/runs', ...(deps.runStartGuards ?? []), async (req, res) => {
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    // A bodiless POST is an empty request.
    const parsed = startRunRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    await respond(res, async () => {
      const run = await projects.startRun(currentUser(req).id, params.data.projectId);
      res.status(201).json({ run: runSummary(run) } satisfies StartRunResponse);
    });
  });

  return router;
}
