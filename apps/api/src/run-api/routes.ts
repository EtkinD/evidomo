import {
  fileDownloadQuerySchema,
  projectRunsParamsSchema,
  runArtifactParamsSchema,
  runEventCursorSchema,
  runEventsQuerySchema,
  runFactParamsSchema,
  runMaterialParamsSchema,
  resumeRunRequestSchema,
  runParamsSchema,
  RUN_FACT_MASK_PNG,
  type ExportFileRole,
  type ProjectRunsResponse,
  type ResumeRunResponse,
  type RunExportResponse,
  type RunSnapshot,
} from '@evidomo/shared';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { z } from 'zod';
import { currentUser, type SessionMiddleware } from '../auth/session.ts';
import type { Run } from '../db/repositories/runs.ts';
import { PACK_CONTENT_SECURITY_POLICY } from '../export/html.ts';
import { sendError, sendValidationError } from '../http/errors.ts';
import { requireJsonBody } from '../http/guards.ts';
import type { Logger } from '../logger.ts';
import type { Storage } from '../storage/storage.ts';
import type { RunEventStreams } from './event-stream.ts';
import { encodeMaskPng } from './mask.ts';
import type { RunResumer } from './resume.ts';
import {
  etagMatches,
  sendStoredFile,
  setFileHeaders,
  type FileCachePolicy,
  type StoredFileResponse,
} from './send-file.ts';
import type { ExportLinks, RunApiService, ServableMaterial } from './service.ts';

// The run, evidence, and export routes (docs/architecture.md §5 "Run API"). Every route is
// behind `requireUser` per route (not `router.use`), so these routers can share the `/api/runs`
// and `/api/projects` prefixes with other routers without running their middleware on them.
// A missing ID and another user's ID both answer 404 `not_found`, never 403.

/**
 * The HTML pack's own CSP (its meta tag) as a header, plus `base-uri 'none'; form-action 'none'`
 * (the pack has no base or form, so nothing injected can redirect URLs or submit anywhere) and
 * `frame-ancestors 'self'` (a meta CSP cannot restrict framing; the web app may embed the pack in
 * a same-origin iframe while no other site may). No `sandbox` yet: its effect on printing is
 * unverified.
 */
export const PACK_RESPONSE_CSP = `${PACK_CONTENT_SECURITY_POLICY}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;

/**
 * Every run route starts with `no-store` (errors and anything a route does not cache on
 * purpose); successful responses set their own policy.
 */
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

export function parseOr400<T>(schema: z.ZodType<T>, value: unknown, res: Response): T | undefined {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return undefined;
  }
  return parsed.data;
}

/** `?download=1` → attachment, else inline; 400 (undefined) for any other value. */
export function disposition(req: Request, res: Response): 'inline' | 'attachment' | undefined {
  const query = parseOr400(fileDownloadQuerySchema, req.query, res);
  if (query === undefined) return undefined;
  return query.download === '1' ? 'attachment' : 'inline';
}

/** A material as a stored file response (run-scoped, demo, and project-scoped routes). */
export function materialFile(
  { material, extension }: ServableMaterial,
  fileDisposition: 'inline' | 'attachment',
  cache: FileCachePolicy,
): StoredFileResponse {
  const base = material.kind === 'voice_memo' ? 'voice-memo' : 'photo';
  return {
    storageKey: material.storageKey,
    contentType: material.mimeType,
    etag: material.sha256,
    fileName: `${base}-${material.id}.${extension}`,
    disposition: fileDisposition,
    rangeable: true,
    cache,
  };
}

const EXPORT_CONTENT_TYPES: Readonly<Record<ExportFileRole, string>> = {
  html: 'text/html; charset=utf-8',
  portal_fields: 'application/json; charset=utf-8',
  image: 'image/jpeg',
};

/**
 * Who may read a run and how its responses are cached: the owner's API (`/api/runs`, session and
 * ownership, private) or the public demo API (`/api/demo/runs`, the allow-list, public caching).
 * Both mount the same read routes through `addRunReadRoutes`, so the two never drift apart.
 */
export interface RunReadAccess {
  /** Run before every read route (authentication or the demo's per-IP limit, then `noStore`). */
  readonly guards: readonly RequestHandler[];
  /** The run this request may read, or undefined (404 `not_found`). */
  resolve(req: Request, runId: string): Promise<Run | undefined>;
  /** The snapshot this request may read, or undefined (404). */
  snapshot(req: Request, runId: string): Promise<RunSnapshot | undefined>;
  /** `Cache-Control` of successful JSON bodies (snapshot, export manifest). */
  readonly jsonCacheControl: string;
  /** Caching of evidence and export files (also 304s). */
  readonly fileCache: FileCachePolicy;
  readonly exportLinks: ExportLinks;
}

export interface RunReadRoutesDeps {
  readonly service: RunApiService;
  readonly storage: Storage;
  readonly logger: Logger;
}

/**
 * The read-only run routes both APIs share: snapshot, evidence files (material, transcript
 * audio, image artifact, fact mask), and the export with its files. All are GET (HEAD works too).
 */
export function addRunReadRoutes(
  router: Router,
  { service, storage, logger }: RunReadRoutesDeps,
  access: RunReadAccess,
): void {
  const { guards, fileCache } = access;

  /** Validates `:runId` (and any other params) and resolves the run, or answers 400/404. */
  async function readableRun<P extends { runId: string }>(
    req: Request,
    res: Response,
    schema: z.ZodType<P>,
  ): Promise<{ run: Run; params: P } | undefined> {
    const params = parseOr400(schema, req.params, res);
    if (params === undefined) return undefined;
    const run = await access.resolve(req, params.runId);
    if (run === undefined) {
      sendError(res, 404, 'not_found');
      return undefined;
    }
    return { run, params };
  }

  function sendJson(res: Response, body: unknown): void {
    res.set('Cache-Control', access.jsonCacheControl);
    res.json(body);
  }

  router.get('/:runId', ...guards, async (req, res) => {
    const params = parseOr400(runParamsSchema, req.params, res);
    if (params === undefined) return;
    const snapshot = await access.snapshot(req, params.runId);
    if (snapshot === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    sendJson(res, snapshot satisfies RunSnapshot);
  });

  router.get('/:runId/materials/:materialId/file', ...guards, async (req, res) => {
    const fileDisposition = disposition(req, res);
    if (fileDisposition === undefined) return;
    const readable = await readableRun(req, res, runMaterialParamsSchema);
    if (readable === undefined) return;
    const servable = await service.material(readable.run, readable.params.materialId);
    if (servable === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    await sendStoredFile(
      req,
      res,
      storage,
      materialFile(servable, fileDisposition, fileCache),
      logger,
    );
  });

  router.get('/:runId/transcripts/:artifactId/audio', ...guards, async (req, res) => {
    const fileDisposition = disposition(req, res);
    if (fileDisposition === undefined) return;
    const readable = await readableRun(req, res, runArtifactParamsSchema);
    if (readable === undefined) return;
    const servable = await service.transcriptAudio(readable.run, readable.params.artifactId);
    if (servable === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    await sendStoredFile(
      req,
      res,
      storage,
      materialFile(servable, fileDisposition, fileCache),
      logger,
    );
  });

  router.get('/:runId/artifacts/:artifactId/file', ...guards, async (req, res) => {
    const fileDisposition = disposition(req, res);
    if (fileDisposition === undefined) return;
    const readable = await readableRun(req, res, runArtifactParamsSchema);
    if (readable === undefined) return;
    const servable = await service.imageArtifact(readable.run, readable.params.artifactId);
    if (servable === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    const { artifact, extension } = servable;
    await sendStoredFile(
      req,
      res,
      storage,
      {
        storageKey: artifact.storageKey,
        contentType: artifact.mimeType,
        etag: artifact.id,
        fileName: `image-${artifact.id}.${extension}`,
        disposition: fileDisposition,
        rangeable: true,
        cache: fileCache,
      },
      logger,
    );
  });

  router.get('/:runId/facts/:factId/mask.png', ...guards, async (req, res) => {
    const readable = await readableRun(req, res, runFactParamsSchema);
    if (readable === undefined) return;
    const { factId } = readable.params;
    const source = await service.factMaskSource(readable.run, factId);
    if (source === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    // The overlay is a pure function of the fact and the inventory it cites (both immutable),
    // so their IDs version it and a revalidation never decodes a mask.
    const etag = `"mask-v1-${source.factId}-${source.inventoryArtifactId}"`;
    if (etagMatches(req.get('if-none-match'), etag)) {
      setFileHeaders(res, { noTransform: false, cache: fileCache });
      res.set('ETag', etag);
      res.status(304).end();
      return;
    }
    const result = await service.renderFactMask(readable.run, source);
    if (result.kind !== 'rendered') {
      if (result.kind === 'no_mask' && result.skipped > 0) {
        logger.warn(
          { runId: readable.run.id, factId, skippedRegions: result.skipped },
          'fact mask regions could not be read',
        );
      }
      sendError(res, 404, 'not_found');
      return;
    }
    const png = await encodeMaskPng(result.layer);
    setFileHeaders(res, { noTransform: false, cache: fileCache });
    res.set('ETag', etag);
    res.status(200);
    res.set('Content-Type', RUN_FACT_MASK_PNG.mimeType);
    res.set('Content-Disposition', `inline; filename="mask-${factId}.png"`);
    res.set('Content-Length', String(png.byteLength));
    res.end(req.method === 'HEAD' ? undefined : png);
  });

  router.get('/:runId/export', ...guards, async (req, res) => {
    const readable = await readableRun(req, res, runParamsSchema);
    if (readable === undefined) return;
    const body = await service.exportManifest(readable.run, access.exportLinks);
    if (body === undefined) {
      sendError(res, 409, 'export_not_ready');
      return;
    }
    sendJson(res, body satisfies RunExportResponse);
  });

  router.get('/:runId/export/files/:artifactId', ...guards, async (req, res) => {
    const fileDisposition = disposition(req, res);
    if (fileDisposition === undefined) return;
    const readable = await readableRun(req, res, runArtifactParamsSchema);
    if (readable === undefined) return;
    const file = await service.exportFile(readable.run, readable.params.artifactId);
    if (file === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    await sendStoredFile(
      req,
      res,
      storage,
      {
        storageKey: file.artifact.storageKey,
        contentType: EXPORT_CONTENT_TYPES[file.role],
        etag: file.sha256,
        fileName: file.fileName,
        // The portal fields are data for another system: always a download.
        disposition: file.role === 'portal_fields' ? 'attachment' : fileDisposition,
        // Images seek like any other; HTML and JSON may be compressed by the proxy instead.
        rangeable: file.role === 'image',
        cache: fileCache,
        ...(file.role === 'html'
          ? { headers: { 'Content-Security-Policy': PACK_RESPONSE_CSP } }
          : {}),
      },
      logger,
    );
  });
}

export interface RunApiRouterDeps {
  readonly service: RunApiService;
  readonly streams: RunEventStreams;
  readonly storage: Storage;
  readonly session: SessionMiddleware;
  readonly logger: Logger;
}

/**
 * The owner's run routes, mounted at `/api/runs`. Every route is behind `requireUser` per route
 * (not `router.use`), so the router can share its prefix with the gate router.
 */
export function createRunApiRouter({
  service,
  streams,
  storage,
  session,
  logger,
}: RunApiRouterDeps): Router {
  const router = Router();

  router.get('/:runId/events', session.requireUser, async (req, res) => {
    const params = parseOr400(runParamsSchema, req.params, res);
    if (params === undefined) return;
    const query = parseOr400(runEventsQuerySchema, req.query, res);
    if (query === undefined) return;
    const lastEventId = req.get('last-event-id');
    let afterSeq = query.after ?? 0;
    if (lastEventId !== undefined) {
      const cursor = parseOr400(runEventCursorSchema, lastEventId, res);
      if (cursor === undefined) return;
      afterSeq = cursor;
    }
    // Ownership is checked once, here; the stream then only follows this run's events.
    const run = await service.ownedRun(currentUser(req).id, params.runId);
    if (run === undefined) {
      res.set('Cache-Control', 'no-store');
      sendError(res, 404, 'not_found');
      return;
    }
    if (req.method === 'HEAD') {
      res.status(200).type('text/event-stream').end();
      return;
    }
    await streams.serve(res, { runId: run.id, userId: currentUser(req).id, afterSeq });
  });

  addRunReadRoutes(
    router,
    { service, storage, logger },
    {
      guards: [session.requireUser, noStore],
      resolve: (req, runId) => service.ownedRun(currentUser(req).id, runId),
      snapshot: (req, runId) => service.snapshot(currentUser(req).id, runId),
      // Snapshots and manifests carry run state: never cached.
      jsonCacheControl: 'no-store',
      fileCache: { kind: 'private' },
      exportLinks: 'owner',
    },
  );

  return router;
}

export interface ProjectRunsRouterDeps {
  readonly service: RunApiService;
  readonly session: SessionMiddleware;
}

/** `GET /api/projects/:projectId/runs`, mounted at `/api/projects`. */
export function createProjectRunsRouter({ service, session }: ProjectRunsRouterDeps): Router {
  const router = Router();
  router.get('/:projectId/runs', session.requireUser, noStore, async (req, res) => {
    const params = parseOr400(projectRunsParamsSchema, req.params, res);
    if (params === undefined) return;
    const runs = await service.listProjectRuns(currentUser(req).id, params.projectId);
    if (runs === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    res.json({ runs } satisfies ProjectRunsResponse);
  });
  return router;
}

export interface RunResumeRouterDeps {
  readonly resumer: RunResumer;
  readonly service: RunApiService;
  readonly session: SessionMiddleware;
  /**
   * The run start guards (`createRunStartGuards`, P4-10), the same array as the run start route,
   * so starts and resumes share one allowance. None when omitted (development and tests).
   */
  readonly runStartGuards?: readonly RequestHandler[];
}

/**
 * `POST /api/runs/:runId/resume` (P5-03), mounted at `/api/runs` with per-route guards like the
 * other run routes. The Origin check runs app-wide; `requireJsonBody` and the run start guards
 * run here, after authentication and before the handler.
 */
export function createRunResumeRouter({
  resumer,
  service,
  session,
  runStartGuards = [],
}: RunResumeRouterDeps): Router {
  const router = Router();
  router.post(
    '/:runId/resume',
    session.requireUser,
    noStore,
    requireJsonBody,
    ...runStartGuards,
    async (req, res) => {
      const params = parseOr400(runParamsSchema, req.params, res);
      if (params === undefined) return;
      // A bodiless POST is an empty request, as for a run start.
      if (parseOr400(resumeRunRequestSchema, req.body ?? {}, res) === undefined) return;
      const userId = currentUser(req).id;
      const outcome = await resumer.resume(userId, params.runId);
      if (outcome.kind === 'refused') {
        sendError(res, outcome.reason === 'not_found' ? 404 : 409, outcome.reason);
        return;
      }
      // After the commit, through the snapshot read the GET route uses (cost visibility
      // included); a worker may already have moved the run on.
      const snapshot = await service.snapshot(userId, outcome.run.id);
      if (snapshot === undefined) {
        // Only if the run failed again and its project was deleted in between.
        sendError(res, 404, 'not_found');
        return;
      }
      res.json({ run: snapshot } satisfies ResumeRunResponse);
    },
  );
  return router;
}
