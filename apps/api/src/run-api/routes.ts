import {
  fileDownloadQuerySchema,
  projectRunsParamsSchema,
  runArtifactParamsSchema,
  runEventCursorSchema,
  runEventsQuerySchema,
  runFactParamsSchema,
  runMaterialParamsSchema,
  runParamsSchema,
  RUN_FACT_MASK_PNG,
  type ExportFileRole,
  type ProjectRunsResponse,
  type RunExportResponse,
  type RunSnapshot,
} from '@evidomo/shared';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { z } from 'zod';
import { currentUser, type SessionMiddleware } from '../auth/session.ts';
import type { Run } from '../db/repositories/runs.ts';
import { PACK_CONTENT_SECURITY_POLICY } from '../export/html.ts';
import { sendError, sendValidationError } from '../http/errors.ts';
import type { Logger } from '../logger.ts';
import type { Storage } from '../storage/storage.ts';
import type { RunEventStreams } from './event-stream.ts';
import { encodeMaskPng } from './mask.ts';
import {
  etagMatches,
  sendStoredFile,
  setPrivateFileHeaders,
  type StoredFileResponse,
} from './send-file.ts';
import type { RunApiService, ServableMaterial } from './service.ts';

// The run, evidence, and export routes (docs/architecture.md §5 "Run API"). Every route is
// behind `requireUser` per route (not `router.use`), so these routers can share the `/api/runs`
// and `/api/projects` prefixes with other routers without running their middleware on them.
// A missing ID and another user's ID both answer 404 `not_found`, never 403.

export interface RunApiRouterDeps {
  readonly service: RunApiService;
  readonly streams: RunEventStreams;
  readonly storage: Storage;
  readonly session: SessionMiddleware;
  readonly logger: Logger;
}

/**
 * The HTML pack's own CSP (its meta tag) as a header, plus `base-uri 'none'; form-action 'none'`
 * (the pack has no base or form, so nothing injected can redirect URLs or submit anywhere) and
 * `frame-ancestors 'self'` (a meta CSP cannot restrict framing; the web app may embed the pack in
 * a same-origin iframe while no other site may). No `sandbox` yet: its effect on printing is
 * unverified.
 */
export const PACK_RESPONSE_CSP = `${PACK_CONTENT_SECURITY_POLICY}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;

const noStore: RequestHandler = (_req, res, next) => {
  // Snapshots and manifests carry run state: never cached.
  res.set('Cache-Control', 'no-store');
  next();
};

function parseOr400<T>(schema: z.ZodType<T>, value: unknown, res: Response): T | undefined {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return undefined;
  }
  return parsed.data;
}

function disposition(req: Request, res: Response): 'inline' | 'attachment' | undefined {
  const query = parseOr400(fileDownloadQuerySchema, req.query, res);
  if (query === undefined) return undefined;
  return query.download === '1' ? 'attachment' : 'inline';
}

function materialFile(
  { material, extension }: ServableMaterial,
  fileDisposition: 'inline' | 'attachment',
): StoredFileResponse {
  const base = material.kind === 'voice_memo' ? 'voice-memo' : 'photo';
  return {
    storageKey: material.storageKey,
    contentType: material.mimeType,
    etag: material.sha256,
    fileName: `${base}-${material.id}.${extension}`,
    disposition: fileDisposition,
    rangeable: true,
  };
}

const EXPORT_CONTENT_TYPES: Readonly<Record<ExportFileRole, string>> = {
  html: 'text/html; charset=utf-8',
  portal_fields: 'application/json; charset=utf-8',
  image: 'image/jpeg',
};

export function createRunApiRouter({
  service,
  streams,
  storage,
  session,
  logger,
}: RunApiRouterDeps): Router {
  const router = Router();

  /** Validates `:runId` (and any other params) and loads the user's run, or answers 400/404. */
  async function ownedRun<P extends { runId: string }>(
    req: Request,
    res: Response,
    schema: z.ZodType<P>,
  ): Promise<{ run: Run; params: P } | undefined> {
    const params = parseOr400(schema, req.params, res);
    if (params === undefined) return undefined;
    const run = await service.ownedRun(currentUser(req).id, params.runId);
    if (run === undefined) {
      sendError(res, 404, 'not_found');
      return undefined;
    }
    return { run, params };
  }

  router.get('/:runId', session.requireUser, noStore, async (req, res) => {
    const params = parseOr400(runParamsSchema, req.params, res);
    if (params === undefined) return;
    const snapshot = await service.snapshot(currentUser(req).id, params.runId);
    if (snapshot === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    res.json(snapshot satisfies RunSnapshot);
  });

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

  router.get('/:runId/materials/:materialId/file', session.requireUser, async (req, res) => {
    const fileDisposition = disposition(req, res);
    if (fileDisposition === undefined) return;
    const owned = await ownedRun(req, res, runMaterialParamsSchema);
    if (owned === undefined) return;
    const servable = await service.material(owned.run, owned.params.materialId);
    if (servable === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    await sendStoredFile(req, res, storage, materialFile(servable, fileDisposition), logger);
  });

  router.get('/:runId/transcripts/:artifactId/audio', session.requireUser, async (req, res) => {
    const fileDisposition = disposition(req, res);
    if (fileDisposition === undefined) return;
    const owned = await ownedRun(req, res, runArtifactParamsSchema);
    if (owned === undefined) return;
    const servable = await service.transcriptAudio(owned.run, owned.params.artifactId);
    if (servable === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    await sendStoredFile(req, res, storage, materialFile(servable, fileDisposition), logger);
  });

  router.get('/:runId/artifacts/:artifactId/file', session.requireUser, async (req, res) => {
    const fileDisposition = disposition(req, res);
    if (fileDisposition === undefined) return;
    const owned = await ownedRun(req, res, runArtifactParamsSchema);
    if (owned === undefined) return;
    const servable = await service.imageArtifact(owned.run, owned.params.artifactId);
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
      },
      logger,
    );
  });

  router.get('/:runId/facts/:factId/mask.png', session.requireUser, async (req, res) => {
    const owned = await ownedRun(req, res, runFactParamsSchema);
    if (owned === undefined) return;
    const { factId } = owned.params;
    const source = await service.factMaskSource(owned.run, factId);
    if (source === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    // The overlay is a pure function of the fact and the inventory it cites (both immutable),
    // so their IDs version it and a revalidation never decodes a mask.
    const etag = `"mask-v1-${source.factId}-${source.inventoryArtifactId}"`;
    if (etagMatches(req.get('if-none-match'), etag)) {
      setPrivateFileHeaders(res, { noTransform: false });
      res.set('ETag', etag);
      res.status(304).end();
      return;
    }
    const result = await service.renderFactMask(owned.run, source);
    if (result.kind !== 'rendered') {
      if (result.kind === 'no_mask' && result.skipped > 0) {
        logger.warn(
          { runId: owned.run.id, factId, skippedRegions: result.skipped },
          'fact mask regions could not be read',
        );
      }
      sendError(res, 404, 'not_found');
      return;
    }
    const png = await encodeMaskPng(result.layer);
    setPrivateFileHeaders(res, { noTransform: false });
    res.set('ETag', etag);
    res.status(200);
    res.set('Content-Type', RUN_FACT_MASK_PNG.mimeType);
    res.set('Content-Disposition', `inline; filename="mask-${factId}.png"`);
    res.set('Content-Length', String(png.byteLength));
    res.end(req.method === 'HEAD' ? undefined : png);
  });

  router.get('/:runId/export', session.requireUser, noStore, async (req, res) => {
    const owned = await ownedRun(req, res, runParamsSchema);
    if (owned === undefined) return;
    const body = await service.exportManifest(owned.run);
    if (body === undefined) {
      sendError(res, 409, 'export_not_ready');
      return;
    }
    res.json(body satisfies RunExportResponse);
  });

  router.get('/:runId/export/files/:artifactId', session.requireUser, async (req, res) => {
    const fileDisposition = disposition(req, res);
    if (fileDisposition === undefined) return;
    const owned = await ownedRun(req, res, runArtifactParamsSchema);
    if (owned === undefined) return;
    const file = await service.exportFile(owned.run, owned.params.artifactId);
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
        ...(file.role === 'html'
          ? { headers: { 'Content-Security-Policy': PACK_RESPONSE_CSP } }
          : {}),
      },
      logger,
    );
  });

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
