import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXPORT_MANIFEST_ARTIFACT_KIND,
  exportManifestContentSchema,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  QA_CARDS_ARTIFACT_KIND,
  photoInventoryContentSchema,
  portalFieldsSchema,
  qaCardsContentSchema,
  STAGED_IMAGES_ARTIFACT_KIND,
  stagedImagesContentSchema,
  usdAmountSchema,
  type ServiceDefinition,
} from '@evidomo/shared';
import { z } from 'zod';
import { getArtifact, listArtifacts } from '../db/repositories/artifacts.ts';
import { listRunSteps } from '../db/repositories/run-steps.ts';
import type { Run } from '../db/repositories/runs.ts';
import { getRunCostUsd, getRunStepCostUsd, listUsageForRun } from '../db/repositories/usage.ts';
import { createUser } from '../db/repositories/users.ts';
import { startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { loadDefinitions } from '../definitions/loader.ts';
import { DEFAULT_DEV_DAILY_BUDGET_USD } from '../env.ts';
import type { Logger } from '../logger.ts';
import { cassettePath } from '../meta/fixtures.ts';
import type { MetaReplay } from '../meta/replay.ts';
import { droppedCardCount } from '../pipeline/qa/generate.ts';
import { readAll } from '../pipeline/vision/handler.ts';
import { createLocalStorage } from '../storage/local.ts';
import type { Storage } from '../storage/storage.ts';
import type { FixtureImageAliases } from './image-aliases.ts';
import { executePipeline, type GateRecords } from './execute.ts';
import { loadProject, withVoiceMemo, type Project } from './project.ts';
import type { PhotoSummary, PipelineMode, PipelineSummary, StepSummary } from './summary.ts';

// The headless pipeline (P3-10, docs/architecture.md §5 "Headless pipeline CLI"): one project
// directory through the real run engine, step handlers, and gate services (`execute.ts`), on a
// throwaway PostgreSQL (Testcontainers) and a temp storage root. Gate decisions come from the project's
// decisions file. Fixture mode replays a recorded run through MSW and cannot reach the network;
// record mode runs live and writes that cassette; live mode calls the API directly.

export interface RunPipelineOptions {
  readonly projectDir: string;
  readonly mode: PipelineMode;
  readonly outDir: string;
  /** Overwrite the export files of an earlier run in `outDir` (other files are kept). */
  readonly force?: boolean;
  /** Replaces the project's voice memo, e.g. a local TTS walkthrough that is not committed. */
  readonly voiceMemo?: string;
  readonly decisionsPath?: string;
  /** Replaces the project's `fixture` cassette (fixtures and record modes). */
  readonly cassette?: string;
  /** `MODEL_API_KEY` (live and record) and `DAILY_BUDGET_USD`. */
  readonly env: NodeJS.ProcessEnv;
  readonly logger: Logger;
  /** Progress lines while the run is in flight. */
  readonly progress: (line: string) => void;
  readonly timeoutMs?: number;
  readonly definitionsDir?: string;
}

/** A problem with how the CLI was invoked, found before anything ran. */
export class PipelineUsageError extends Error {
  override name = 'PipelineUsageError';
}

const OPERATOR_EMAIL = 'pipeline-cli@example.invalid';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Export files are the HTML pack (images embedded), the JSON, and JPEGs. */
const MAX_EXPORT_FILE_BYTES = 256 * 1024 * 1024;
const EXPORT_FILE_NAME = /^(listing-pack\.html|portal-fields\.json|photo-\d+(-staged)?\.jpg)$/;
export const SUMMARY_FILE = 'summary.json';

const dailyCapSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  usdAmountSchema.default(DEFAULT_DEV_DAILY_BUDGET_USD),
);

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Refuses a non-empty `outDir` unless `force`, which removes only earlier export files. */
async function prepareOutDir(outDir: string, force: boolean): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const entries = await readdir(outDir);
  if (entries.length === 0) return;
  if (!force) {
    throw new PipelineUsageError(
      `Output directory ${outDir} is not empty; choose another --out or pass --force`,
    );
  }
  for (const name of entries) {
    if (EXPORT_FILE_NAME.test(name) || name === SUMMARY_FILE) await rm(path.join(outDir, name));
  }
}

/** Reads one artifact kind of the run; none or several give null (the step did not finish). */
async function singleContent(
  db: TestDatabase['db'],
  runId: string,
  kind: string,
): Promise<unknown> {
  const rows = await listArtifacts(db, runId, { kind });
  return rows.length === 1 ? rows[0]?.content : null;
}

/** Vision's classification and staging's outcome per photo, by project file name. */
async function photoSummaries(
  db: TestDatabase['db'],
  runId: string,
  photoNames: ReadonlyMap<string, string>,
): Promise<PhotoSummary[]> {
  const inventoryContent = await singleContent(db, runId, PHOTO_INVENTORY_ARTIFACT_KIND);
  if (inventoryContent === null) return [];
  const inventory = photoInventoryContentSchema.parse(inventoryContent);
  const stagedContent = await singleContent(db, runId, STAGED_IMAGES_ARTIFACT_KIND);
  const staged = stagedContent === null ? null : stagedImagesContentSchema.parse(stagedContent);
  return inventory.photos.map((photo) => {
    const c = photo.classification;
    const outcome = staged?.photos.find((o) => o.materialId === photo.materialId);
    return {
      photo: photoNames.get(photo.materialId) ?? photo.materialId,
      subject: c.status === 'ok' ? c.subject : null,
      furnishing: c.status === 'ok' ? c.furnishing : null,
      coverRank: c.status === 'ok' ? c.coverRank : null,
      privacy: photo.privacy.status,
      staging:
        outcome === undefined
          ? null
          : {
              status: outcome.status,
              operationId: outcome.operationId,
              reason: outcome.status === 'staged' ? null : outcome.reason,
            },
    };
  });
}

/** Every stored set of Q&A cards, in revision order; null when there is none. */
async function qaSummary(
  db: TestDatabase['db'],
  runId: string,
): Promise<PipelineSummary['qaCards']> {
  const rows = await listArtifacts(db, runId, { kind: QA_CARDS_ARTIFACT_KIND });
  if (rows.length === 0) return null;
  return {
    drafts: rows
      .map((row) => {
        const content = qaCardsContentSchema.parse(row.content);
        return {
          stepId: row.stepId,
          revision: content.revision,
          cards: content.counts.cards,
          segments: content.counts.segments,
          droppedCards: droppedCardCount(content),
          validatorFailedSegments: content.validation.counts.failedSegments,
        };
      })
      // Artifacts of one transaction share `created_at`; revisions are numbered by their loop.
      .sort((a, b) => a.revision - b.revision),
  };
}

async function buildSummary(
  db: TestDatabase['db'],
  run: Run,
  service: ServiceDefinition,
  context: {
    scriptFailure: string | null;
    mode: PipelineMode;
    cassette: string | null;
    startedAt: number;
    gates: GateRecords;
    exported: PipelineSummary['export'];
    replay: MetaReplay | undefined;
    aliases: FixtureImageAliases;
    photoNames: ReadonlyMap<string, string>;
  },
): Promise<PipelineSummary> {
  const rows = await listRunSteps(db, run.id);
  const steps: StepSummary[] = [];
  for (const step of service.steps) {
    const attempts = rows.filter((row) => row.stepId === step.id);
    const last = attempts.at(-1);
    steps.push({
      stepId: step.id,
      status: last?.status ?? 'not_started',
      attempts: attempts.length,
      executions: attempts.reduce((sum, row) => sum + row.executions, 0),
      costUsd: await getRunStepCostUsd(db, run.id, step.id),
    });
  }
  const usage = await listUsageForRun(db, run.id);
  const models = [...new Set(usage.map((u) => u.modelId))].sort();
  const byModel = models.map((modelId) => {
    const calls = usage.filter((u) => u.modelId === modelId);
    // Exact decimal sum on scaled integers (8 fraction digits, as stored).
    const micro = calls.reduce((sum, u) => sum + BigInt(u.estimatedCostUsd.replace('.', '')), 0n);
    const text = micro.toString().padStart(9, '0');
    return {
      modelId,
      calls: calls.length,
      costUsd: `${text.slice(0, -8)}.${text.slice(-8)}`,
    };
  });
  const { replay } = context;
  return {
    runId: run.id,
    mode: context.mode,
    cassette: context.cassette,
    service: { id: service.id, version: service.version, steps: service.steps.map((s) => s.id) },
    market: { id: run.marketProfileId, version: run.marketProfileVersion },
    status: run.status,
    failureReason: run.failureReason ?? context.scriptFailure,
    durationMs: Date.now() - context.startedAt,
    steps,
    photos: await photoSummaries(db, run.id, context.photoNames),
    factConflicts: context.gates.factConflicts,
    qaCards: await qaSummary(db, run.id),
    claimAudit: context.gates.claimAudit,
    unusedDecisions: context.gates.unused,
    export: context.exported,
    cost: {
      runCostUsd: await getRunCostUsd(db, run.id),
      runCapUsd: service.budget.max_cost_usd_per_run,
      calls: usage.length,
      byModel,
    },
    network:
      replay === undefined
        ? null
        : {
            liveRequests: replay.liveRequestCount,
            servedFromCassette: replay.servedFromCassetteCount,
            unmatched: [...replay.unmatched],
            unnamedImages: context.aliases.unnamedImageCount(),
          },
  };
}

/** Copies the stored export (every file the manifest lists, checksums verified) to `outDir`. */
async function writeExport(
  db: TestDatabase['db'],
  storage: Storage,
  runId: string,
  outDir: string,
): Promise<NonNullable<PipelineSummary['export']>> {
  const [manifestArtifact, ...more] = await listArtifacts(db, runId, {
    kind: EXPORT_MANIFEST_ARTIFACT_KIND,
  });
  if (manifestArtifact === undefined || more.length > 0) {
    throw new Error(
      `Run ${runId} completed with ${more.length + (manifestArtifact ? 1 : 0)} export manifests`,
    );
  }
  const manifest = exportManifestContentSchema.parse(manifestArtifact.content);
  let portalFieldsJson: string | undefined;
  for (const file of manifest.files) {
    const artifact = await getArtifact(db, file.artifactId);
    if (artifact?.storageKey === null || artifact?.storageKey === undefined) {
      throw new Error(`Export file ${file.fileName} has no stored artifact`);
    }
    const bytes = await readAll(await storage.get(artifact.storageKey), MAX_EXPORT_FILE_BYTES);
    if (sha256Hex(bytes) !== file.sha256) {
      throw new Error(`Export file ${file.fileName} does not match its manifest checksum`);
    }
    await writeFile(path.join(outDir, file.fileName), bytes);
    if (file.role === 'portal_fields') portalFieldsJson = Buffer.from(bytes).toString('utf8');
  }
  if (portalFieldsJson === undefined) throw new Error('The export has no portal-fields JSON');
  const fields = portalFieldsSchema.parse(JSON.parse(portalFieldsJson));
  return {
    outDir,
    files: manifest.files.map((f) => ({ fileName: f.fileName, sizeBytes: f.sizeBytes })),
    readyToPublish: manifest.readyToPublish,
    qaCards: fields.qaCards.length,
    checklist: fields.publicationChecklist.items.map((item) => ({
      id: item.id,
      status: item.status,
    })),
    withheld: manifest.counts.withheld,
  };
}

/**
 * Runs one project end to end and returns its summary (also written to `outDir/summary.json`).
 * Throws before the run for invalid input (`ProjectDirError`, `PipelineUsageError`,
 * `InputRejectedError`) and during it when a scripted decision cannot be applied
 * (`ScriptedDecisionError`); a run that fails in the engine is returned with status `failed`.
 */
export async function runPipeline(options: RunPipelineOptions): Promise<PipelineSummary> {
  const startedAt = Date.now();
  const { mode, env, logger, progress } = options;
  const definitions = await loadDefinitions(options.definitionsDir);
  let project: Project = await loadProject(
    options.projectDir,
    definitions,
    (id, version) => definitions.getService(id, version),
    options.decisionsPath,
  );
  if (options.voiceMemo !== undefined) project = await withVoiceMemo(project, options.voiceMemo);
  const cassette = options.cassette ?? project.fixture;
  if (mode !== 'live' && cassette === null) {
    throw new PipelineUsageError(
      `${mode} mode needs a cassette: set "fixture" in project.json or pass --cassette`,
    );
  }
  if (mode === 'fixtures' && cassette !== null && !(await exists(cassettePath(cassette)))) {
    throw new PipelineUsageError(
      `No recorded run at ${cassettePath(cassette)}; record one with --mode record or use --mode live`,
    );
  }
  const apiKey = env['MODEL_API_KEY'];
  if (mode === 'live' && (apiKey === undefined || apiKey === '')) {
    throw new PipelineUsageError('live mode needs MODEL_API_KEY in the environment');
  }
  const dailyCap = dailyCapSchema.safeParse(env['DAILY_BUDGET_USD']);
  if (!dailyCap.success) throw new PipelineUsageError('DAILY_BUDGET_USD is not a valid amount');
  await prepareOutDir(options.outDir, options.force === true);

  progress(`Starting PostgreSQL (Testcontainers) for ${path.basename(project.dir)} ...`);
  // Before MSW starts: Testcontainers talks to Docker over HTTP, which replay would block.
  const testDb = await startTestDatabase();
  const storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-pipeline-'));
  try {
    const db = testDb.db;
    const storage = createLocalStorage({ rootDir: storageDir });
    const user = await createUser(db, { email: OPERATOR_EMAIL, passwordHash: 'not-a-login' });
    const execution = await executePipeline({
      project,
      definitions,
      mode,
      cassette,
      apiKey,
      env,
      dailyCapUsd: dailyCap.data,
      logger,
      progress,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      target: {
        db,
        bossConnectionString: testDb.container.getConnectionUri(),
        storage,
        ownerId: user.id,
      },
    });
    const { run } = execution;
    const exported =
      run.status === 'completed' ? await writeExport(db, storage, run.id, options.outDir) : null;
    const summary = await buildSummary(db, run, project.service, {
      scriptFailure: execution.scriptFailure,
      mode,
      cassette: mode === 'live' ? null : cassette,
      startedAt,
      gates: execution.gates,
      exported,
      replay: execution.replay,
      aliases: execution.aliases,
      photoNames: execution.photoNames,
    });
    await writeFile(
      path.join(options.outDir, SUMMARY_FILE),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );
    return summary;
  } finally {
    // The pipeline stopped pg-boss and MSW already; the container goes last (Docker's HTTP API
    // must not be intercepted).
    await testDb.stop();
    await rm(storageDir, { recursive: true, force: true });
  }
}
