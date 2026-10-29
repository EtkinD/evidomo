import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  APPROVED_PACK_ARTIFACT_KIND,
  CLAIM_AUDIT_ARTIFACT_KIND,
  EXPORT_FORMAT_VERSION,
  EXPORT_HTML_FILE_NAME,
  EXPORT_PORTAL_FIELDS_FILE_NAME,
  INTEGRITY_CHECKS_ARTIFACT_KIND,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  STAGED_IMAGE_ARTIFACT_KIND,
  STAGED_IMAGE_LABEL,
  UPLOAD_LIMITS,
  approvedPackContentSchema,
  claimAuditContentSchema,
  exportManifestContentSchema,
  integrityChecksContentSchema,
  photoInventoryContentSchema,
  stagedImageContentSchema,
  type ApprovedPackContent,
  type ClaimAuditCategory,
  type ExportFileRole,
  type ExportManifestContent,
  type IntegrityChecksContent,
  type InventoryPhoto,
  type PhotoInventoryContent,
  type PortalFields,
  type PortalImage,
  type PortalWithheldImage,
  type PublicationChecklistResult,
  type StagingOperationId,
} from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import { getArtifact, listArtifacts } from '../db/repositories/artifacts.ts';
import { listFacts } from '../db/repositories/facts.ts';
import { getProject } from '../db/repositories/projects.ts';
import type { Run } from '../db/repositories/runs.ts';
import type { DefinitionRegistry } from '../definitions/loader.ts';
import {
  evaluatePublicationChecklist,
  type ClaimDecisionChoice,
} from '../pipeline/checklist/evaluate.ts';
import {
  loadPublicationChecklistInput,
  PublicationChecklistInputError,
} from '../pipeline/checklist/load.ts';
import { CopyCatalogError } from '../pipeline/creative/catalog.ts';
import { STAGED_DIGITAL_SOURCE_TYPE } from '../pipeline/staging/encode.ts';
import { readOriginals } from '../pipeline/staging/handler.ts';
import { readAll } from '../pipeline/vision/handler.ts';
import { NonRetryableStepError } from '../runs/steps.ts';
import { StorageNotFoundError, type Storage } from '../storage/storage.ts';
import { blurPhoto, PhotoBlurError, privacyPlan } from './blur.ts';
import { buildPortalFacts } from './facts.ts';
import { renderListingPackHtml } from './html.ts';
import { exportArtifactId } from './ids.ts';
import { exportPhotoOrder, imageFileName, isPublishableStaged } from './images.ts';
import { composePortalFields, serializePortalFields } from './portal-fields.ts';
import { burnStagedLabel, StagedLabelError } from './label.ts';

// Builds a run's export in memory from its stored artifacts (docs/architecture.md §5, "Export
// (P3-09)"): the approved pack, the photo inventory and stored originals, the integrity record
// and the approved staged files, the verified facts, and the publication checklist. Nothing here
// writes or reads a clock; the step handler (`handler.ts`) stores the result. Inconsistent
// records fail with `NonRetryableStepError` (a retry would read the same records).

export interface ExportDeps {
  readonly storage: Storage;
  readonly markets: Pick<DefinitionRegistry, 'getMarket'>;
}

export interface BuiltExportFile {
  readonly artifactId: string;
  readonly role: ExportFileRole;
  readonly fileName: string;
  readonly mimeType: 'text/html' | 'application/json' | 'image/jpeg';
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface RunExport {
  /** The HTML, the JSON, then the images in export order (the manifest's order). */
  readonly files: readonly BuiltExportFile[];
  readonly manifest: ExportManifestContent;
  readonly manifestArtifactId: string;
  readonly fields: PortalFields;
  readonly checklist: PublicationChecklistResult;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function exportFile(
  runId: string,
  role: ExportFileRole,
  fileName: string,
  mimeType: BuiltExportFile['mimeType'],
  bytes: Uint8Array,
): BuiltExportFile {
  return {
    artifactId: exportArtifactId(runId, fileName),
    role,
    fileName,
    mimeType,
    bytes,
    sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

/** The run's single approved pack, checked against the run and its claim audit. */
export async function readApprovedPack(
  db: Executor,
  run: Pick<Run, 'id' | 'outputLanguage'>,
): Promise<{
  artifactId: string;
  content: ApprovedPackContent;
  /** The claim audit's remaining flag categories per claim, in flag order. */
  flagCategories: Map<string, ClaimAuditCategory[]>;
}> {
  const [artifact, ...others] = await listArtifacts(db, run.id, {
    kind: APPROVED_PACK_ARTIFACT_KIND,
  });
  if (artifact === undefined) {
    throw new NonRetryableStepError('The export needs the approved pack, and the run has none');
  }
  if (others.length > 0) throw new NonRetryableStepError('The run has more than one approved pack');
  const parsed = approvedPackContentSchema.safeParse(artifact.content);
  if (!parsed.success) throw new NonRetryableStepError('The approved pack is not valid');
  const pack = parsed.data;
  if (pack.outputLanguage !== run.outputLanguage) {
    throw new NonRetryableStepError('The approved pack is not in the run output language');
  }
  const audit = await getArtifact(db, pack.claimAuditArtifactId);
  const auditContent = claimAuditContentSchema.safeParse(audit?.content);
  if (
    audit?.runId !== run.id ||
    audit.kind !== CLAIM_AUDIT_ARTIFACT_KIND ||
    !auditContent.success ||
    auditContent.data.finalDraftArtifactId !== pack.finalDraftArtifactId
  ) {
    throw new NonRetryableStepError('The approved pack does not match the run claim audit');
  }
  const flagCategories = new Map<string, ClaimAuditCategory[]>();
  for (const flag of auditContent.data.remainingFlags) {
    const categories = flagCategories.get(flag.claimId) ?? [];
    if (!categories.includes(flag.category)) categories.push(flag.category);
    flagCategories.set(flag.claimId, categories);
  }
  return { artifactId: artifact.id, content: pack, flagCategories };
}

async function readInventory(
  db: Executor,
  runId: string,
): Promise<{ artifactId: string; content: PhotoInventoryContent }> {
  const [inventory, ...others] = await listArtifacts(db, runId, {
    kind: PHOTO_INVENTORY_ARTIFACT_KIND,
  });
  if (inventory === undefined) {
    throw new NonRetryableStepError('The export needs the photo inventory, and the run has none');
  }
  if (others.length > 0) {
    throw new NonRetryableStepError('The run has more than one photo inventory');
  }
  const parsed = photoInventoryContentSchema.safeParse(inventory.content);
  if (!parsed.success) throw new NonRetryableStepError('The photo inventory is not valid');
  return { artifactId: inventory.id, content: parsed.data };
}

async function readIntegrity(
  db: Executor,
  runId: string,
  pack: ApprovedPackContent,
): Promise<IntegrityChecksContent | null> {
  if (pack.integrityChecksArtifactId === null) {
    if (pack.images.length > 0) {
      throw new NonRetryableStepError('The approved pack lists staged photos without a record');
    }
    return null;
  }
  const artifact = await getArtifact(db, pack.integrityChecksArtifactId);
  const content = integrityChecksContentSchema.safeParse(artifact?.content);
  if (artifact?.runId !== runId || artifact.kind !== INTEGRITY_CHECKS_ARTIFACT_KIND) {
    throw new NonRetryableStepError('The approved pack names an integrity record of no run step');
  }
  if (!content.success) throw new NonRetryableStepError('The integrity record is not valid');
  return content.data;
}

/** Gate 2's decisions as the checklist loader takes them, from the approved pack (P3-08). */
async function evaluateChecklist(
  db: Executor,
  markets: ExportDeps['markets'],
  run: Run,
  pack: ApprovedPackContent,
): Promise<PublicationChecklistResult> {
  const segments = pack.variants.flatMap((variant) => variant.segments);
  const claimDecisions: { claimId: string; choice: ClaimDecisionChoice }[] = [];
  for (const segment of segments) {
    if (segment.origin === 'accepted')
      claimDecisions.push({ claimId: segment.claimId, choice: 'accept' });
    if (segment.origin === 'edited')
      claimDecisions.push({ claimId: segment.claimId, choice: 'edit' });
  }
  for (const claimId of pack.removedClaimIds) claimDecisions.push({ claimId, choice: 'remove' });
  try {
    const input = await loadPublicationChecklistInput(db, markets, {
      run,
      approvedStagedArtifactIds: pack.images.flatMap((image) =>
        image.publishedArtifactId === null ? [] : [image.publishedArtifactId],
      ),
      claimDecisions,
    });
    return evaluatePublicationChecklist(input);
  } catch (error) {
    if (error instanceof PublicationChecklistInputError) {
      // The loader's messages name IDs and counts only.
      throw new NonRetryableStepError(`The checklist inputs do not fit the run: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function readStagedFile(storage: Storage, key: string, sha256: string): Promise<Uint8Array> {
  let stream: Readable;
  try {
    stream = await storage.get(key);
  } catch (error) {
    if (error instanceof StorageNotFoundError) {
      throw new NonRetryableStepError('An approved staged image file is missing', { cause: error });
    }
    throw error;
  }
  const bytes = await readAll(stream, UPLOAD_LIMITS.photoMaxBytes);
  if (sha256Hex(bytes) !== sha256) {
    throw new NonRetryableStepError('An approved staged image does not match its checksum');
  }
  return bytes;
}

type StagedLoad =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly operationId: StagingOperationId }
  | { readonly ok: false };

/** The approved staged image's file, if the records allow exporting it (`isPublishableStaged`). */
async function loadPublishableStaged(
  deps: ExportDeps,
  db: Executor,
  runId: string,
  publishedArtifactId: string,
  photo: InventoryPhoto,
  integrity: IntegrityChecksContent | null,
): Promise<StagedLoad> {
  const artifact = await getArtifact(db, publishedArtifactId);
  const content = stagedImageContentSchema.safeParse(artifact?.content);
  const valid =
    artifact?.runId === runId &&
    artifact.kind === STAGED_IMAGE_ARTIFACT_KIND &&
    artifact.storageKey !== null &&
    content.success;
  const record = valid ? content.data : null;
  if (
    record === null ||
    artifact?.storageKey == null ||
    !isPublishableStaged({ publishedArtifactId, photo, integrity, record })
  ) {
    return { ok: false };
  }
  const bytes = await readStagedFile(deps.storage, artifact.storageKey, record.stored.sha256);
  return { ok: true, bytes, operationId: record.operation.id };
}

interface ExportedImages {
  readonly images: PortalImage[];
  readonly withheld: PortalWithheldImage[];
  readonly bytes: Map<string, Uint8Array>;
  readonly blurredImages: number;
  readonly blurredRegions: number;
}

async function exportImages(
  deps: ExportDeps,
  db: Executor,
  run: Run,
  inventory: PhotoInventoryContent,
  pack: ApprovedPackContent,
  integrity: IntegrityChecksContent | null,
  signal: AbortSignal | undefined,
): Promise<ExportedImages> {
  const ordered = exportPhotoOrder(inventory);
  const inventoried = new Set(inventory.photos.map((photo) => photo.materialId));
  const published = new Map<string, string>();
  for (const image of pack.images) {
    if (!inventoried.has(image.materialId)) {
      throw new NonRetryableStepError('The approved pack names a photo the inventory lacks');
    }
    if (image.publishedArtifactId === null) continue;
    if (published.has(image.materialId)) {
      throw new NonRetryableStepError('The approved pack publishes two staged images of a photo');
    }
    published.set(image.materialId, image.publishedArtifactId);
  }

  const planned = ordered.map((entry) => ({ ...entry, plan: privacyPlan(entry.photo) }));
  const exportable = planned.flatMap((entry) =>
    entry.plan.status === 'exportable' ? [entry.photo] : [],
  );
  // Each original is re-read and checked against the inventory's SHA-256 and frame, so the
  // boxes are blurred on exactly the pixels the privacy check saw.
  const originals = await readOriginals(
    deps,
    db,
    run.projectId,
    exportable.map((photo) => ({
      materialId: photo.materialId,
      sha256: photo.materialSha256,
      width: photo.width,
      height: photo.height,
    })),
  );
  const originalBytes = new Map(originals.map((photo) => [photo.materialId, photo.bytes]));

  const images: PortalImage[] = [];
  const withheld: PortalWithheldImage[] = [];
  const bytes = new Map<string, Uint8Array>();
  let blurredImages = 0;
  let blurredRegions = 0;
  let photoNumber = 0;

  for (const { photo, uploadPosition, plan } of planned) {
    signal?.throwIfAborted();
    const stagedId = published.get(photo.materialId) ?? null;
    const withhold = (reason: PortalWithheldImage['reason']): void => {
      withheld.push({
        materialId: photo.materialId,
        uploadPosition,
        kind: 'original',
        stagedArtifactId: null,
        reason,
      });
      if (stagedId !== null) {
        withheld.push({
          materialId: photo.materialId,
          uploadPosition,
          kind: 'staged',
          stagedArtifactId: stagedId,
          reason: 'original_withheld',
        });
      }
    };
    if (plan.status === 'withheld') {
      withhold(plan.reason);
      continue;
    }
    const stored = originalBytes.get(photo.materialId);
    if (stored === undefined) throw new Error('An exportable original was not read');
    let original: Uint8Array = stored;
    if (plan.boxes.length > 0) {
      try {
        original = (await blurPhoto(stored, photo, plan.boxes)).bytes;
      } catch (error) {
        if (!(error instanceof PhotoBlurError)) throw error;
        withhold('blur_failed');
        continue;
      }
    }

    let staged: {
      bytes: Uint8Array;
      width: number;
      height: number;
      operationId: StagingOperationId;
    } | null = null;
    if (stagedId !== null) {
      const load = await loadPublishableStaged(deps, db, run.id, stagedId, photo, integrity);
      if (!load.ok) {
        withheld.push({
          materialId: photo.materialId,
          uploadPosition,
          kind: 'staged',
          stagedArtifactId: stagedId,
          reason: 'staged_unverified',
        });
      } else {
        try {
          const labeled = await burnStagedLabel(load.bytes);
          staged = { ...labeled, operationId: load.operationId };
        } catch (error) {
          if (!(error instanceof StagedLabelError)) throw error;
          withheld.push({
            materialId: photo.materialId,
            uploadPosition,
            kind: 'staged',
            stagedArtifactId: stagedId,
            reason: 'label_failed',
          });
        }
      }
    }

    photoNumber += 1;
    const originalName = imageFileName(photoNumber, 'original');
    const stagedName = imageFileName(photoNumber, 'staged');
    if (staged !== null && stagedId !== null) {
      images.push({
        position: images.length + 1,
        fileName: stagedName,
        fileArtifactId: exportArtifactId(run.id, stagedName),
        materialId: photo.materialId,
        width: staged.width,
        height: staged.height,
        sizeBytes: staged.bytes.byteLength,
        sha256: sha256Hex(staged.bytes),
        kind: 'staged',
        stagedArtifactId: stagedId,
        operationId: staged.operationId,
        disclosure: {
          label: STAGED_IMAGE_LABEL,
          burnedIn: true,
          digitalSourceType: STAGED_DIGITAL_SOURCE_TYPE,
        },
        originalFileName: originalName,
      });
      bytes.set(stagedName, staged.bytes);
    }
    images.push({
      position: images.length + 1,
      fileName: originalName,
      fileArtifactId: exportArtifactId(run.id, originalName),
      materialId: photo.materialId,
      width: photo.width,
      height: photo.height,
      sizeBytes: original.byteLength,
      sha256: sha256Hex(original),
      kind: 'original',
      coverRank: photo.classification.status === 'ok' ? photo.classification.coverRank : null,
      subject: photo.classification.status === 'ok' ? photo.classification.subject : null,
      privacy: {
        status: plan.boxes.length > 0 ? 'masked' : 'clear',
        blurredRegions: plan.boxes.length,
      },
      stagedFileName: staged === null ? null : stagedName,
    });
    bytes.set(originalName, original);
    if (plan.boxes.length > 0) {
      blurredImages += 1;
      blurredRegions += plan.boxes.length;
    }
  }
  return { images, withheld, bytes, blurredImages, blurredRegions };
}

/**
 * Builds the export of a run whose Gate 2 is approved. The same stored artifacts always give
 * byte-identical HTML and JSON (and, on one machine, identical images): no clock, stable order,
 * content-derived artifact IDs, and the schema's key order.
 */
export async function buildRunExport(
  deps: ExportDeps,
  db: Executor,
  run: Run,
  options: { readonly signal?: AbortSignal } = {},
): Promise<RunExport> {
  const project = await getProject(db, run.projectId);
  if (project === undefined) throw new NonRetryableStepError('The run has no project');
  const market = deps.markets.getMarket(run.marketProfileId, run.marketProfileVersion);
  const pack = await readApprovedPack(db, run);
  const inventory = await readInventory(db, run.id);
  const integrity = await readIntegrity(db, run.id, pack.content);
  const facts = await listFacts(db, run.id, { status: 'verified' });
  const checklist = await evaluateChecklist(db, deps.markets, run, pack.content);

  let portalFacts: PortalFields['facts'];
  try {
    portalFacts = buildPortalFacts(market, facts, inventory.content);
  } catch (error) {
    if (error instanceof CopyCatalogError) {
      throw new NonRetryableStepError(`The verified facts cannot be exported: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }

  const exported = await exportImages(
    deps,
    db,
    run,
    inventory.content,
    pack.content,
    integrity,
    options.signal,
  );

  const fields = composePortalFields({
    runId: run.id,
    pack,
    market,
    facts: portalFacts,
    images: exported.images,
    withheld: exported.withheld,
    checklist,
  });
  const json = serializePortalFields(fields);
  const html = renderListingPackHtml({
    fields,
    market,
    title: project.title,
    office: project.officeProfile,
    images: exported.bytes,
    warnings: pack.content.warnings,
    flagCategories: pack.flagCategories,
  });

  const files: BuiltExportFile[] = [
    exportFile(run.id, 'html', EXPORT_HTML_FILE_NAME, 'text/html', Buffer.from(html, 'utf8')),
    exportFile(
      run.id,
      'portal_fields',
      EXPORT_PORTAL_FIELDS_FILE_NAME,
      'application/json',
      Buffer.from(json, 'utf8'),
    ),
    ...fields.images.map((image) => {
      const imageBytes = exported.bytes.get(image.fileName);
      if (imageBytes === undefined) throw new Error(`No bytes for ${image.fileName}`);
      return exportFile(run.id, 'image', image.fileName, 'image/jpeg', imageBytes);
    }),
  ];
  const manifest = exportManifestContentSchema.parse({
    schemaVersion: 1,
    formatVersion: EXPORT_FORMAT_VERSION,
    approvedPackArtifactId: pack.artifactId,
    inventoryArtifactId: inventory.artifactId,
    readyToPublish: checklist.summary.readyToPublish,
    files: files.map((file) => ({
      artifactId: file.artifactId,
      role: file.role,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    })),
    counts: {
      images: fields.images.length,
      originals: fields.images.filter((image) => image.kind === 'original').length,
      staged: fields.images.filter((image) => image.kind === 'staged').length,
      blurredImages: exported.blurredImages,
      blurredRegions: exported.blurredRegions,
      withheld: fields.withheld.length,
    },
  } satisfies ExportManifestContent);
  return {
    files,
    manifest,
    manifestArtifactId: exportArtifactId(run.id, 'manifest'),
    fields,
    checklist,
  };
}
