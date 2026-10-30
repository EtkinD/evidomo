import { Router, type Request, type Response } from 'express';
import {
  materialParamsSchema,
  PHOTO_UPLOAD_CONTENT_TYPES,
  projectParamsSchema,
  UPLOAD_LIMITS,
  VOICE_MEMO_UPLOAD_CONTENT_TYPES,
  type ApiError,
  type MaterialKind,
  type UploadLimits,
  type UploadMaterialResponse,
  type UploadRejectionCode,
} from '@evidomo/shared';
import { currentUser } from '../auth/session.ts';
import type { Executor } from '../db/client.ts';
import { getProjectMaterial, listMaterials, type Material } from '../db/repositories/materials.ts';
import { getProjectForOwner } from '../db/repositories/projects.ts';
import { sendError, sendValidationError } from '../http/errors.ts';
import type { Logger } from '../logger.ts';
import { UploadRejectedError } from '../media/upload-error.ts';
import {
  UploadConflictError,
  uploadBlocker,
  type ProcessUpload,
  type UploadConflictReason,
} from '../upload/process-upload.ts';
import {
  declaredLength,
  receiveUploadToTempFile,
  UploadAbortedError,
  UploadBodyTooLargeError,
} from '../upload/receive.ts';
import type { UploadSlots } from '../upload/slots.ts';
import { disposition, materialFile } from '../run-api/routes.ts';
import { sendStoredFile } from '../run-api/send-file.ts';
import { servableMaterial } from '../run-api/service.ts';
import type { Storage } from '../storage/storage.ts';
import { ProjectRequestError, type ProjectService } from './projects.ts';
import { sendProjectError } from './routes.ts';
import { materialView } from './views.ts';

export interface MaterialRouterDeps {
  readonly db: Executor;
  readonly projects: ProjectService;
  readonly processUpload: ProcessUpload;
  readonly logger: Logger;
  readonly limits?: UploadLimits;
  /** The private upload temp directory (`createUploadTempDir`). */
  readonly tempDir: () => Promise<string>;
  /** In-flight upload slots, taken before the body is received. */
  readonly slots: UploadSlots;
  /** Stored materials, served by `GET /:materialId/file`. */
  readonly storage: Storage;
}

/** Seconds a client should wait after `too_many_uploads`; an upload rarely takes longer. */
export const UPLOAD_RETRY_AFTER_SECONDS = 5;

interface UploadRoute {
  readonly kind: MaterialKind;
  readonly contentTypes: readonly string[];
  readonly maxBytes: number;
  readonly successStatus: 200 | 201;
}

/**
 * Answers before the body was read. `Connection: close` stops Node from reading (and discarding)
 * the rest of a large body to keep the connection alive.
 */
function refuse(res: Response, status: number, body: ApiError): void {
  res.set('Connection', 'close');
  res.status(status).json(body);
}

function rejectionStatus(code: UploadRejectionCode): number {
  return code === 'file_too_large' ? 413 : 422;
}

function conflictBody(reason: Exclude<UploadConflictReason, 'project_not_found'>): ApiError {
  return { error: reason === 'inputs_locked' ? 'inputs_locked' : 'photo_limit_reached' };
}

/**
 * Mounted by the project router at `/api/projects/:projectId/materials` (after `requireUser`, with
 * the Origin guard applied app-wide). One file per request as the raw body:
 *
 * - `POST /photos` (`image/jpeg|png|webp|heic|heif`) → 201 `{ material }`, appended last;
 * - `PUT /voice-memo` (the audio types in `VOICE_MEMO_UPLOAD_CONTENT_TYPES`) → 200 `{ material }`,
 *   replacing any earlier memo;
 * - `DELETE /:materialId` → 204;
 * - `GET /:materialId/file[?download=1]` → the stored file (owner-only, Range-capable), served
 *   like the run-scoped material route, so capture can show it before any run exists.
 */
export function createMaterialRouter(deps: MaterialRouterDeps): Router {
  const { db, projects, processUpload, logger } = deps;
  const limits = deps.limits ?? UPLOAD_LIMITS;
  const router = Router({ mergeParams: true });

  async function upload(req: Request, res: Response, route: UploadRoute): Promise<void> {
    const params = projectParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.set('Connection', 'close');
      sendValidationError(res, params.error);
      return;
    }
    const length = declaredLength(req);
    const hasBody = req.headers['transfer-encoding'] !== undefined || (length ?? 0) > 0;
    if (!hasBody) {
      refuse(res, 422, { error: 'upload_rejected', reason: 'empty_file' });
      return;
    }
    // A CSRF guard like `requireJsonBody`: none of these types can be sent cross-site without a
    // preflight. The file itself is identified by its content later.
    if (req.is([...route.contentTypes]) === false) {
      refuse(res, 415, { error: 'unsupported_media_type' });
      return;
    }
    const user = currentUser(req);
    const project = await getProjectForOwner(db, params.data.projectId, user.id);
    if (project === undefined) {
      refuse(res, 404, { error: 'not_found' });
      return;
    }
    // The stored ID from here on: `z.uuid()` accepts upper case, which PostgreSQL matches but a
    // storage key (lower case only) refuses.
    const projectId = project.id;
    // Checked again under the project lock when the row is written; this only avoids receiving
    // and processing a file that cannot be accepted.
    const blocker = await uploadBlocker(db, projectId, route.kind, projects.service().capture);
    if (blocker !== undefined) {
      refuse(res, 409, conflictBody(blocker));
      return;
    }
    if (length !== undefined && length > route.maxBytes) {
      refuse(res, 413, { error: 'upload_rejected', reason: 'file_too_large' });
      return;
    }
    // Before any byte is received: receiving is what fills the temp disk.
    const release = deps.slots.tryAcquire(user.id);
    if (release === undefined) {
      res.set('Retry-After', String(UPLOAD_RETRY_AFTER_SECONDS));
      refuse(res, 429, { error: 'too_many_uploads' });
      return;
    }
    try {
      await receiveAndProcess(req, res, route, user.id, projectId);
    } finally {
      // Success, rejection, abort, and error alike.
      release();
    }
  }

  async function receiveAndProcess(
    req: Request,
    res: Response,
    route: UploadRoute,
    userId: string,
    projectId: string,
  ): Promise<void> {
    const aborted = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) aborted.abort();
    });

    let tempFilePath: string;
    try {
      tempFilePath = await receiveUploadToTempFile(req, {
        maxBytes: route.maxBytes,
        tempDir: await deps.tempDir(),
      });
    } catch (error) {
      if (error instanceof UploadBodyTooLargeError) {
        refuse(res, 413, { error: 'upload_rejected', reason: 'file_too_large' });
        return;
      }
      if (error instanceof UploadAbortedError) {
        logger.info({ userId, projectId, kind: route.kind }, 'upload aborted by client');
        return;
      }
      throw error;
    }

    let material: Material;
    try {
      material = await processUpload({
        projectId,
        kind: route.kind,
        tempFilePath,
        clientMime: req.get('content-type'),
        signal: aborted.signal,
      });
    } catch (error) {
      if (aborted.signal.aborted) {
        // Whatever failed, the client is gone and nothing was committed after the abort.
        logger.info({ userId, projectId, kind: route.kind }, 'upload aborted by client');
        return;
      }
      if (error instanceof UploadRejectedError) {
        // The code only: the message is shown by the web from the code, and the cause may hold
        // decoder output.
        logger.info({ userId, projectId, kind: route.kind, reason: error.code }, 'upload rejected');
        res
          .status(rejectionStatus(error.code))
          .json({ error: 'upload_rejected', reason: error.code } satisfies ApiError);
        return;
      }
      if (error instanceof UploadConflictError) {
        if (error.reason === 'project_not_found') res.status(404).json({ error: 'not_found' });
        else res.status(409).json(conflictBody(error.reason));
        return;
      }
      throw error;
    }

    const siblings = await listMaterials(db, projectId, { kind: route.kind });
    const position = siblings.findIndex((candidate) => candidate.id === material.id) + 1;
    res.status(route.successStatus).json({
      material: materialView(material, Math.max(position, 1)),
    } satisfies UploadMaterialResponse);
  }

  router.post('/photos', async (req, res) => {
    await upload(req, res, {
      kind: 'photo',
      contentTypes: PHOTO_UPLOAD_CONTENT_TYPES,
      maxBytes: limits.photoMaxBytes,
      successStatus: 201,
    });
  });

  router.put('/voice-memo', async (req, res) => {
    await upload(req, res, {
      kind: 'voice_memo',
      contentTypes: VOICE_MEMO_UPLOAD_CONTENT_TYPES,
      maxBytes: limits.voiceMemoMaxBytes,
      successStatus: 200,
    });
  });

  router.get('/:materialId/file', async (req, res) => {
    const fileDisposition = disposition(req, res);
    if (fileDisposition === undefined) return;
    const params = materialParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    const { projectId, materialId } = params.data;
    // Another user's project and another project's material are both 404, never 403.
    if ((await getProjectForOwner(db, projectId, currentUser(req).id)) === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    const servable = servableMaterial(await getProjectMaterial(db, projectId, materialId));
    if (servable === undefined) {
      sendError(res, 404, 'not_found');
      return;
    }
    await sendStoredFile(
      req,
      res,
      deps.storage,
      materialFile(servable, fileDisposition, { kind: 'private' }),
      logger,
    );
  });

  router.delete('/:materialId', async (req, res) => {
    const params = materialParamsSchema.safeParse(req.params);
    if (!params.success) {
      sendValidationError(res, params.error);
      return;
    }
    try {
      await projects.deleteMaterial(
        currentUser(req).id,
        params.data.projectId,
        params.data.materialId,
      );
      res.status(204).end();
    } catch (error) {
      if (!(error instanceof ProjectRequestError)) throw error;
      sendProjectError(res, error);
    }
  });

  return router;
}
