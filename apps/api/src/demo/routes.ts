import {
  demoClaimAuditGateResponseSchema,
  demoRunEventsQuerySchema,
  DEMO_REPLAY_SPEED,
  runEventCursorSchema,
  runParamsSchema,
  type DemoClaimAuditGateResponse,
  type DemoRunListResponse,
  type FactConflictsGateResponse,
} from '@evidomo/shared';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { createFixedWindowLimiter, ipRateLimitKey, type RateLimit } from '../auth/rate-limit.ts';
import type { Run } from '../db/repositories/runs.ts';
import type { ClaimAuditGate } from '../gates/claim-audit.ts';
import type { FactConflictsGate } from '../gates/fact-conflicts.ts';
import { sendError } from '../http/errors.ts';
import type { Logger } from '../logger.ts';
import { addRunReadRoutes, noStore, parseOr400 } from '../run-api/routes.ts';
import type { RunApiService } from '../run-api/service.ts';
import type { Storage } from '../storage/storage.ts';
import type { DemoReplayStreams } from './replay.ts';
import type { DemoRuns } from './runs.ts';

// The public demo API (docs/architecture.md §5 "Demo API", §11), mounted at `/api/demo/runs`:
// GET only, no session, limited per client IP. It serves the completed runs listed in
// `DEMO_RUN_IDS` through the owner API's own read routes (`addRunReadRoutes`) and gate services,
// so a visitor walks the whole flow (monitor replay, both gates as decided, evidence, export)
// without an account. Nothing here writes: there are no other methods (a PUT or POST is 404).

/** Every demo request per client IP: a whole walk-through (photos, masks, audio seeks) fits. */
export const DEFAULT_DEMO_REQUEST_LIMIT: RateLimit = { limit: 2000, windowMs: 15 * 60 * 1000 };

export interface DemoCachePolicy {
  /** Snapshot, gates, export manifest, run list. Short, so de-listing a run takes effect soon. */
  readonly jsonMaxAgeSeconds: number;
  /** Evidence and export files (immutable under their IDs; revalidated against the ETag). */
  readonly fileMaxAgeSeconds: number;
}

export const DEFAULT_DEMO_CACHE: DemoCachePolicy = {
  jsonMaxAgeSeconds: 60,
  fileMaxAgeSeconds: 3600,
};

export interface DemoRouterDeps {
  readonly runs: DemoRuns;
  readonly service: RunApiService;
  readonly gate: Pick<FactConflictsGate, 'view'>;
  readonly claimAudit: Pick<ClaimAuditGate, 'view'>;
  readonly replay: DemoReplayStreams;
  readonly storage: Storage;
  readonly logger: Logger;
  readonly requestLimit?: RateLimit;
  readonly cache?: DemoCachePolicy;
}

function clientKey(req: Request): string {
  // `req.ip` honours the narrowly configured `trust proxy` (one hop: Caddy); IPv6 by /64. Keys
  // both the request limit and the open-stream cap.
  return ipRateLimitKey(req.ip);
}

export function createDemoRouter(deps: DemoRouterDeps): Router {
  const { runs, service, logger } = deps;
  const cache = deps.cache ?? DEFAULT_DEMO_CACHE;
  const jsonCacheControl = `public, max-age=${cache.jsonMaxAgeSeconds}`;
  const limiter = createFixedWindowLimiter(deps.requestLimit ?? DEFAULT_DEMO_REQUEST_LIMIT);

  const limitPerIp: RequestHandler = (req, res, next) => {
    const decision = limiter.consume(clientKey(req));
    if (!decision.allowed) {
      // The IP stays out of the log.
      logger.warn({ limiter: 'demo_ip' }, 'rate limit exceeded');
      res.set('Cache-Control', 'no-store');
      res.set('Retry-After', String(decision.retryAfterSeconds));
      sendError(res, 429, 'rate_limited');
      return;
    }
    next();
  };
  const guards = [limitPerIp, noStore];

  function sendJson(res: Response, body: unknown): void {
    res.set('Cache-Control', jsonCacheControl);
    res.json(body);
  }

  /** Validates `:runId` and resolves the demo run, or answers 400/404. */
  async function demoRun(req: Request, res: Response): Promise<Run | undefined> {
    const params = parseOr400(runParamsSchema, req.params, res);
    if (params === undefined) return undefined;
    const run = await runs.resolve(params.runId);
    if (run === undefined) sendError(res, 404, 'not_found');
    return run;
  }

  const router = Router();

  router.get('/', ...guards, async (_req, res) => {
    sendJson(res, { runs: await runs.list() } satisfies DemoRunListResponse);
  });

  router.get('/:runId/events', ...guards, async (req, res) => {
    const params = parseOr400(runParamsSchema, req.params, res);
    if (params === undefined) return;
    const query = parseOr400(demoRunEventsQuerySchema, req.query, res);
    if (query === undefined) return;
    const lastEventId = req.get('last-event-id');
    let afterSeq = query.after ?? 0;
    if (lastEventId !== undefined) {
      const cursor = parseOr400(runEventCursorSchema, lastEventId, res);
      if (cursor === undefined) return;
      afterSeq = cursor;
    }
    const run = await runs.resolve(params.runId);
    if (run === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    if (req.method === 'HEAD') {
      res.status(200).type('text/event-stream').end();
      return;
    }
    await deps.replay.serve(res, {
      runId: run.id,
      clientKey: clientKey(req),
      afterSeq,
      speed: query.speed ?? DEMO_REPLAY_SPEED.default,
    });
  });

  router.get('/:runId/gates/fact-conflicts', ...guards, async (req, res) => {
    const run = await demoRun(req, res);
    if (run === undefined) return;
    sendJson(res, (await deps.gate.view(run)) satisfies FactConflictsGateResponse);
  });

  router.get('/:runId/gates/claim-audit', ...guards, async (req, res) => {
    const run = await demoRun(req, res);
    if (run === undefined) return;
    const { approval, ...gate } = await deps.claimAudit.view(run);
    // The sign-off's `decidedBy` is a user ID: dropped, and the strict schema proves it.
    const body = demoClaimAuditGateResponseSchema.parse({
      ...gate,
      approval: approval === null ? null : { decidedAt: approval.decidedAt },
    } satisfies DemoClaimAuditGateResponse);
    sendJson(res, body);
  });

  addRunReadRoutes(
    router,
    { service, storage: deps.storage, logger },
    {
      guards,
      resolve: (_req, runId) => runs.resolve(runId),
      async snapshot(_req, runId) {
        const run = await runs.resolve(runId);
        return run === undefined ? undefined : service.runSnapshot(run.id);
      },
      jsonCacheControl,
      fileCache: { kind: 'public', maxAgeSeconds: cache.fileMaxAgeSeconds },
      exportLinks: 'demo',
    },
  );

  return router;
}
