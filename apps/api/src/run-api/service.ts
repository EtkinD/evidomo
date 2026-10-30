import {
  demoExportFileUrl,
  demoRunExportResponseSchema,
  EXPORT_MANIFEST_ARTIFACT_KIND,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  TRANSCRIPT_ARTIFACT_KIND,
  photoInventoryContentSchema,
  runExportResponseSchema,
  runExportFileUrl,
  runSnapshotSchema,
  runSummarySchema,
  transcriptArtifactContentSchema,
  exportManifestContentSchema,
  type ExportManifestContent,
  type ExportFileRole,
  type RunExportResponse,
  type RunSnapshot,
  type RunStepSnapshot,
  type RunSummary,
  type ServiceDefinition,
} from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import { getArtifact, listArtifacts, type Artifact } from '../db/repositories/artifacts.ts';
import { getFactsByIds } from '../db/repositories/facts.ts';
import { getProjectMaterial, type Material } from '../db/repositories/materials.ts';
import { getProjectForOwner } from '../db/repositories/projects.ts';
import { listRunSteps, type RunStep } from '../db/repositories/run-steps.ts';
import { getRun, getRunForOwner, listRunsForProject, type Run } from '../db/repositories/runs.ts';
import { getRunCostUsd, getRunStepCostsUsd, getRunsCostUsd } from '../db/repositories/usage.ts';
import { DefinitionNotFoundError, type DefinitionRegistry } from '../definitions/loader.ts';
import { MAX_STEP_EXECUTIONS } from '../runs/queue.ts';
import { disclosedReason, type RunCostVisibility } from './cost-visibility.ts';
import { observationRegions, renderMaskLayer, type MaskLayerResult } from './mask.ts';

// Reads behind the run, evidence, and export routes (docs/architecture.md §5 "Run API"). Every
// entry point takes the requesting user and answers `undefined` both for a missing ID and for one
// owned by someone else, so the routes can only ever say 404.

const ZERO_USD = '0.00000000';

export interface RunApiServiceDeps {
  readonly db: Executor;
  readonly services: Pick<DefinitionRegistry, 'getService'>;
  /**
   * `hidden`: snapshots and summaries carry no cost keys (and no ledger is read for them), and
   * failure reasons and step errors state budget failures without amounts.
   */
  readonly costs: RunCostVisibility;
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function serviceOf(
  services: Pick<DefinitionRegistry, 'getService'>,
  run: Run,
): ServiceDefinition | null {
  try {
    return services.getService(run.serviceId, run.serviceVersion);
  } catch (error) {
    // A run of a definition version no longer deployed still gets a snapshot, without cap.
    if (error instanceof DefinitionNotFoundError) return null;
    throw error;
  }
}

/** Spreads `{ costUsd }` only when costs are disclosed (`undefined` means hidden). */
function costField(costUsd: string | undefined): { costUsd?: string } {
  return costUsd === undefined ? {} : { costUsd };
}

function summaryOf(run: Run, costUsd: string | undefined, costs: RunCostVisibility): RunSummary {
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    serviceId: run.serviceId,
    serviceVersion: run.serviceVersion,
    marketProfileId: run.marketProfileId,
    marketProfileVersion: run.marketProfileVersion,
    outputLanguage: run.outputLanguage,
    gate: run.gate,
    currentStepId: run.currentStepId,
    failureReason: run.failureReason === null ? null : disclosedReason(run.failureReason, costs),
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    ...costField(costUsd),
  };
}

function stepSnapshot(
  stepId: string,
  definition: ServiceDefinition['steps'][number] | undefined,
  attempts: readonly RunStep[],
  costUsd: string | undefined,
  costs: RunCostVisibility,
): RunStepSnapshot {
  const latest = attempts.reduce<RunStep | undefined>(
    (newest, row) => (newest === undefined || row.attempt > newest.attempt ? row : newest),
    undefined,
  );
  const released = attempts.find((row) => row.gateReleasedAt !== null);
  return {
    stepId,
    agent: definition?.agent ?? null,
    gateAfter: definition?.gate_after ?? null,
    status: latest?.status ?? 'pending',
    attempt: latest?.attempt ?? null,
    attempts: attempts.length,
    executions: latest?.executions ?? 0,
    totalExecutions: attempts.reduce((sum, row) => sum + row.executions, 0),
    ...costField(costUsd),
    startedAt: iso(latest?.startedAt ?? null),
    finishedAt: iso(latest?.finishedAt ?? null),
    gateReleasedAt: iso(released?.gateReleasedAt ?? null),
    error: latest?.error == null ? null : disclosedReason(latest.error, costs),
  };
}

export interface LoadedExport {
  readonly artifact: Artifact;
  readonly manifest: ExportManifestContent;
}

/** The run's stored export manifest; undefined until the export step has committed. */
export async function loadRunExport(
  db: Executor,
  runId: string,
): Promise<LoadedExport | undefined> {
  const manifests = await listArtifacts(db, runId, { kind: EXPORT_MANIFEST_ARTIFACT_KIND });
  const [artifact, ...others] = manifests;
  if (artifact === undefined) return undefined;
  // One export step per definition, and the step writes one manifest (its idempotency check).
  if (others.length > 0) throw new Error(`Run has ${manifests.length} export manifests`);
  return { artifact, manifest: exportManifestContentSchema.parse(artifact.content) };
}

/** A material of the run's project that is ready to serve, with its download extension. */
export interface ServableMaterial {
  readonly material: Material;
  readonly extension: 'jpg' | 'wav';
}

const MATERIAL_EXTENSIONS: Readonly<Record<string, 'jpg' | 'wav'>> = {
  'image/jpeg': 'jpg',
  'audio/wav': 'wav',
};

/** A `ready` material with a servable type (JPEG photo, WAV memo), else undefined. */
export function servableMaterial(material: Material | undefined): ServableMaterial | undefined {
  if (material === undefined || material.status !== 'ready') return undefined;
  const extension = MATERIAL_EXTENSIONS[material.mimeType];
  return extension === undefined ? undefined : { material, extension };
}

/** Image artifacts only: HTML and JSON are served by the export route with their own headers. */
const ARTIFACT_IMAGE_EXTENSIONS: Readonly<Record<string, 'jpg' | 'png'>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export interface ServableArtifact {
  readonly artifact: Artifact & { storageKey: string; mimeType: string };
  readonly extension: 'jpg' | 'png';
}

export interface ServableExportFile {
  readonly artifact: Artifact & { storageKey: string };
  readonly role: ExportFileRole;
  readonly fileName: string;
  readonly mimeType: 'text/html' | 'application/json' | 'image/jpeg';
  readonly sha256: string;
}

/** A `photo_region` fact that cites a mask: what identifies its overlay (and versions it). */
export interface FactMaskSource {
  readonly factId: string;
  readonly factKey: string;
  readonly materialId: string;
  readonly inventoryArtifactId: string;
}

export type FactMaskResult =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'no_mask'; readonly skipped: number }
  | { readonly kind: 'rendered'; readonly layer: Extract<MaskLayerResult, { kind: 'rendered' }> };

/** Whose URLs the export manifest links to: the owner's run API or the public demo API. */
export type ExportLinks = 'owner' | 'demo';

export interface RunApiService {
  snapshot(userId: string, runId: string): Promise<RunSnapshot | undefined>;
  /**
   * The snapshot of a run the caller has already resolved without an owner (the public demo
   * API's allow-list); undefined once the run is gone.
   */
  runSnapshot(runId: string): Promise<RunSnapshot | undefined>;
  listProjectRuns(userId: string, projectId: string): Promise<RunSummary[] | undefined>;
  ownedRun(userId: string, runId: string): Promise<Run | undefined>;
  material(run: Run, materialId: string): Promise<ServableMaterial | undefined>;
  imageArtifact(run: Run, artifactId: string): Promise<ServableArtifact | undefined>;
  transcriptAudio(run: Run, transcriptArtifactId: string): Promise<ServableMaterial | undefined>;
  /** The fact's mask identity (one indexed read), before anything is decoded. */
  factMaskSource(run: Run, factId: string): Promise<FactMaskSource | undefined>;
  renderFactMask(run: Run, source: FactMaskSource): Promise<FactMaskResult>;
  /** `undefined` when the run has no export yet. File links default to the owner's API. */
  exportManifest(run: Run, links?: ExportLinks): Promise<RunExportResponse | undefined>;
  exportFile(run: Run, artifactId: string): Promise<ServableExportFile | undefined>;
}

export function createRunApiService({ db, services, costs }: RunApiServiceDeps): RunApiService {
  const disclosed = costs === 'visible';

  async function runArtifact(run: Run, artifactId: string): Promise<Artifact | undefined> {
    const artifact = await getArtifact(db, artifactId);
    return artifact?.runId === run.id ? artifact : undefined;
  }

  /**
   * One snapshot: the steps, costs, and `lastEventSeq` describe the same instant, so a client
   * that opens the stream at `lastEventSeq` neither misses nor double-counts a change.
   */
  function readSnapshot(
    load: (tx: Executor) => Promise<Run | undefined>,
  ): Promise<RunSnapshot | undefined> {
    return db.transaction(
      async (tx) => {
        const run = await load(tx);
        if (run === undefined) return undefined;
        const service = serviceOf(services, run);
        const rows = await listRunSteps(tx, run.id);
        const stepCosts = disclosed ? await getRunStepCostsUsd(tx, run.id) : undefined;
        const totalUsd = disclosed ? await getRunCostUsd(tx, run.id) : undefined;
        const stepCost = (stepId: string): string | undefined =>
          stepCosts === undefined ? undefined : (stepCosts.get(stepId) ?? ZERO_USD);
        const stored = await loadRunExport(tx, run.id);

        const attemptsByStep = new Map<string, RunStep[]>();
        for (const row of rows) {
          const list = attemptsByStep.get(row.stepId) ?? [];
          list.push(row);
          attemptsByStep.set(row.stepId, list);
        }
        const definitionSteps = service?.steps ?? [];
        const known = new Set(definitionSteps.map((step) => step.id));
        const steps = [
          ...definitionSteps.map((step) =>
            stepSnapshot(
              step.id,
              step,
              attemptsByStep.get(step.id) ?? [],
              stepCost(step.id),
              costs,
            ),
          ),
          ...[...attemptsByStep.entries()]
            .filter(([stepId]) => !known.has(stepId))
            .map(([stepId, attempts]) =>
              stepSnapshot(stepId, undefined, attempts, stepCost(stepId), costs),
            ),
        ];

        return runSnapshotSchema.parse({
          ...summaryOf(run, totalUsd, costs),
          updatedAt: run.updatedAt.toISOString(),
          lastEventSeq: run.lastEventSeq,
          ...(disclosed ? { costCapUsd: service?.budget.max_cost_usd_per_run ?? null } : {}),
          maxExecutionsPerAttempt: MAX_STEP_EXECUTIONS,
          steps,
          export:
            stored === undefined
              ? null
              : {
                  manifestArtifactId: stored.artifact.id,
                  readyToPublish: stored.manifest.readyToPublish,
                  fileCount: stored.manifest.files.length,
                },
        } satisfies RunSnapshot);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  return {
    snapshot: (userId, runId) => readSnapshot((tx) => getRunForOwner(tx, runId, userId)),

    runSnapshot: (runId) => readSnapshot((tx) => getRun(tx, runId)),

    async listProjectRuns(userId, projectId) {
      const project = await getProjectForOwner(db, projectId, userId);
      if (project === undefined) return undefined;
      // Oldest first from the repository; reversed for newest first (ties by ID, descending).
      const runs = (await listRunsForProject(db, project.id)).reverse();
      const runCosts = disclosed
        ? await getRunsCostUsd(
            db,
            runs.map((run) => run.id),
          )
        : undefined;
      return runs.map((run) =>
        runSummarySchema.parse(
          summaryOf(
            run,
            runCosts === undefined ? undefined : (runCosts.get(run.id) ?? ZERO_USD),
            costs,
          ),
        ),
      );
    },

    ownedRun: (userId, runId) => getRunForOwner(db, runId, userId),

    async material(run, materialId) {
      return servableMaterial(await getProjectMaterial(db, run.projectId, materialId));
    },

    async imageArtifact(run, artifactId) {
      const artifact = await runArtifact(run, artifactId);
      if (artifact?.storageKey == null || artifact.mimeType === null) return undefined;
      const extension = ARTIFACT_IMAGE_EXTENSIONS[artifact.mimeType];
      if (extension === undefined) return undefined;
      return {
        artifact: { ...artifact, storageKey: artifact.storageKey, mimeType: artifact.mimeType },
        extension,
      };
    },

    async transcriptAudio(run, transcriptArtifactId) {
      const artifact = await runArtifact(run, transcriptArtifactId);
      if (artifact?.kind !== TRANSCRIPT_ARTIFACT_KIND) return undefined;
      const { materialId } = transcriptArtifactContentSchema.parse(artifact.content);
      const servable = servableMaterial(await getProjectMaterial(db, run.projectId, materialId));
      return servable?.material.kind === 'voice_memo' ? servable : undefined;
    },

    async factMaskSource(run, factId) {
      const [fact] = await getFactsByIds(db, run.id, [factId]);
      if (fact?.source.kind !== 'photo_region' || fact.source.maskArtifactId === undefined) {
        return undefined;
      }
      return {
        factId: fact.id,
        factKey: fact.key,
        materialId: fact.source.materialId,
        inventoryArtifactId: fact.source.maskArtifactId,
      };
    },

    async renderFactMask(run, source) {
      const inventory = await runArtifact(run, source.inventoryArtifactId);
      if (inventory?.kind !== PHOTO_INVENTORY_ARTIFACT_KIND) return { kind: 'not_found' };
      const content = photoInventoryContentSchema.parse(inventory.content);
      const photo = content.photos.find((entry) => entry.materialId === source.materialId);
      if (photo === undefined) return { kind: 'not_found' };
      const layer = renderMaskLayer(
        photo.width,
        photo.height,
        observationRegions(photo, source.factKey),
      );
      return layer.kind === 'empty'
        ? { kind: 'no_mask', skipped: layer.skipped }
        : { kind: 'rendered', layer };
    },

    async exportManifest(run, links = 'owner') {
      const stored = await loadRunExport(db, run.id);
      if (stored === undefined) return undefined;
      const { manifest } = stored;
      const fileUrl = links === 'owner' ? runExportFileUrl : demoExportFileUrl;
      const schema = links === 'owner' ? runExportResponseSchema : demoRunExportResponseSchema;
      return schema.parse({
        runId: run.id,
        manifestArtifactId: stored.artifact.id,
        approvedPackArtifactId: manifest.approvedPackArtifactId,
        readyToPublish: manifest.readyToPublish,
        counts: manifest.counts,
        files: manifest.files.map((file) => ({
          ...file,
          url: fileUrl(run.id, file.artifactId),
          downloadUrl: fileUrl(run.id, file.artifactId, { download: true }),
        })),
      } satisfies RunExportResponse);
    },

    async exportFile(run, artifactId) {
      const stored = await loadRunExport(db, run.id);
      const file = stored?.manifest.files.find((entry) => entry.artifactId === artifactId);
      if (file === undefined) return undefined;
      const artifact = await runArtifact(run, artifactId);
      // The manifest lists only file artifacts of this run; anything else is a broken export.
      if (artifact?.storageKey == null) {
        throw new Error('An export manifest lists an artifact without a stored file');
      }
      return {
        artifact: { ...artifact, storageKey: artifact.storageKey },
        role: file.role,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sha256: file.sha256,
      };
    },
  };
}
