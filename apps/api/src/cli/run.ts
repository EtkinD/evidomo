import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXPORT_MANIFEST_ARTIFACT_KIND,
  exportManifestContentSchema,
  portalFieldsSchema,
  usdAmountSchema,
  type ServiceDefinition,
} from '@evidomo/shared';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { getArtifact, listArtifacts } from '../db/repositories/artifacts.ts';
import { createProject } from '../db/repositories/projects.ts';
import { listRunEvents } from '../db/repositories/run-events.ts';
import { listRunSteps } from '../db/repositories/run-steps.ts';
import { createRun, getRun, type Run } from '../db/repositories/runs.ts';
import { getRunCostUsd, getRunStepCostUsd, listUsageForRun } from '../db/repositories/usage.ts';
import { createUser } from '../db/repositories/users.ts';
import { startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { loadDefinitions } from '../definitions/loader.ts';
import { DEFAULT_DEV_DAILY_BUDGET_USD } from '../env.ts';
import { ClaimAuditGateError, createClaimAuditGate } from '../gates/claim-audit.ts';
import { createFactConflictsGate, FactConflictsGateError } from '../gates/fact-conflicts.ts';
import type { Logger } from '../logger.ts';
import { createMetaClients } from '../meta/clients.ts';
import { cassettePath } from '../meta/fixtures.ts';
import { createMetaReplay, type MetaReplay } from '../meta/replay.ts';
import { createStepHandlers } from '../pipeline/handlers.ts';
import { readAll } from '../pipeline/vision/handler.ts';
import { createRunEngine } from '../runs/engine.ts';
import { createLocalStorage } from '../storage/local.ts';
import type { Storage } from '../storage/storage.ts';
import { createPriceTableCostEstimator } from '../usage/ledger.ts';
import {
  planClaimAuditDecisions,
  planFactConflictDecisions,
  ScriptedDecisionError,
} from './decisions.ts';
import { cliServiceRegistry } from './definition.ts';
import { createFixtureImageAliases, type FixtureImageAliases } from './image-aliases.ts';
import { ingestPhoto, ingestVoiceMemo } from './ingest.ts';
import { loadProject, withVoiceMemo, type Project } from './project.ts';
import type { PipelineMode, PipelineSummary, StepSummary } from './summary.ts';
import { usd } from './summary.ts';

// The headless pipeline (P3-10, docs/architecture.md §5 "Headless pipeline CLI"): one project
// directory through the real run engine, step handlers, and gate services, on a throwaway
// PostgreSQL (Testcontainers) and a temp storage root. Gate decisions come from the project's
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
const POLL_MS = 250;
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

function describeGateError(error: unknown): unknown {
  if (error instanceof FactConflictsGateError) {
    const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return new ScriptedDecisionError(`${error.message}${issues === '' ? '' : ` (${issues})`}`, {
      cause: error,
    });
  }
  if (error instanceof ClaimAuditGateError) {
    const findings = error.findings.map((f) => `${f.code} "${f.token}"`).join('; ');
    return new ScriptedDecisionError(
      `${error.message}${findings === '' ? '' : ` (validator: ${findings})`}`,
      { cause: error },
    );
  }
  return error;
}

interface GateRecords {
  factConflicts: PipelineSummary['factConflicts'];
  claimAudit: PipelineSummary['claimAudit'];
  unused: string[];
}

function eventLine(type: string, payload: Record<string, unknown>): string | undefined {
  const step = typeof payload['stepId'] === 'string' ? payload['stepId'] : '?';
  const cost = typeof payload['stepCostUsd'] === 'string' ? usd(payload['stepCostUsd']) : '';
  switch (type) {
    case 'step_started':
      return `  ... ${step} (attempt ${String(payload['attempt'])}, execution ${String(payload['execution'])})`;
    case 'step_completed':
      return `  ok  ${step} ${cost}`;
    case 'step_failed':
      return `  !!  ${step} failed${payload['willRetry'] === true ? ' (will retry)' : ''}: ${String(payload['reason'])}`;
    case 'gate_opened':
      return `  ==  gate ${String(payload['gate'])} opened`;
    case 'gate_decided':
      return `  ==  gate ${String(payload['gate'])} decided, run resumed`;
    default:
      return undefined;
  }
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
    factConflicts: context.gates.factConflicts,
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
  const registry = cliServiceRegistry(definitions);
  let project: Project = await loadProject(
    options.projectDir,
    definitions,
    registry.getService,
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
  const aliases = createFixtureImageAliases();
  let replay: MetaReplay | undefined;
  let boss: PgBoss | undefined;
  try {
    if (mode !== 'live' && cassette !== null) {
      replay = createMetaReplay({
        cassette,
        mode: mode === 'record' ? 'record' : 'replay',
        env,
        extend: mode === 'record',
        // Intake always sends the memo as `voice-memo.wav`; the TTS walkthrough a run is recorded
        // from may not be committed (docs/model-notes.md, P1-04), so audio matches by name.
        match: { ignoreFileContentFields: ['audio'], imageAlias: aliases.alias },
        onInteraction: aliases.onInteraction,
      });
      await replay.start();
    }
    const storage = createLocalStorage({ rootDir: storageDir });
    const db = testDb.db;
    boss = new PgBoss({ connectionString: testDb.container.getConnectionUri() });
    boss.on('error', (error) => {
      logger.error({ err: error }, 'pg-boss error');
    });
    await boss.start();
    const estimateCost = createPriceTableCostEstimator();
    const clientKey = replay?.apiKey ?? apiKey;
    const engine = createRunEngine({
      db,
      boss,
      registry,
      logger,
      dailyCapUsd: dailyCap.data,
      handlers: createStepHandlers({ storage, markets: definitions }),
      createMetaClients: (usage) =>
        createMetaClients({ apiKey: clientKey, usage, estimateCost, logger }),
    });
    await engine.startWorkers({ pollingIntervalSeconds: 0.5 });
    const factGate = createFactConflictsGate({ db, engine, markets: definitions });
    const auditGate = createClaimAuditGate({ db, engine, markets: definitions });

    const user = await createUser(db, { email: OPERATOR_EMAIL, passwordHash: 'not-a-login' });
    const dbProject = await createProject(db, {
      ownerId: user.id,
      title: project.title,
      officeProfile: project.officeProfile,
      marketProfileId: project.market.id,
      marketProfileVersion: project.market.version,
      outputLanguage: project.outputLanguage,
      factForm: project.factForm,
    });
    progress(`Processing ${project.photos.length} photo(s) and the voice memo ...`);
    const vision = project.service.steps.find((step) => step.agent === 'vision');
    const photoNames = new Map<string, string>();
    for (const photo of project.photos) {
      const ingested = await ingestPhoto(db, storage, dbProject.id, photo);
      photoNames.set(ingested.material.id, ingested.name);
      await aliases.registerPhoto(
        ingested.stored,
        ingested.sourceSha256,
        vision?.agent === 'vision' ? vision.classification_long_edge_px : undefined,
      );
    }
    if (project.voiceMemoPath !== null) {
      await ingestVoiceMemo(db, storage, dbProject.id, project.voiceMemoPath);
    }

    const created = await createRun(db, {
      projectId: dbProject.id,
      serviceId: project.service.id,
      serviceVersion: project.service.version,
      marketProfileId: project.market.id,
      marketProfileVersion: project.market.version,
      outputLanguage: project.outputLanguage,
    });
    progress(`Run ${created.id} started (${mode} mode)`);
    await engine.startRun(created.id);

    const gates: GateRecords = { factConflicts: null, claimAudit: null, unused: [] };
    let scriptFailure: string | null = null;
    const run = await driveRun(created.id, {
      db,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      progress,
      async onFactConflicts() {
        const gate = await factGate.get(user.id, created.id);
        gates.factConflicts = {
          conflictCount: gate.conflictCount,
          conflicts: gate.conflicts.map((c) => `${c.id} ${c.key}`),
          decisions: [],
        };
        const plan = planFactConflictDecisions(gate, project.decisions.factConflicts);
        for (const decision of plan.decisions) {
          await factGate
            .decide(user.id, created.id, decision.conflictId, decision.request)
            .catch((error: unknown) => {
              throw describeGateError(error);
            });
        }
        gates.factConflicts = {
          ...gates.factConflicts,
          decisions: plan.decisions.map((d) => ({
            conflictId: d.conflictId,
            key: d.key,
            decision: d.label,
            origin: d.origin,
          })),
        };
        gates.unused.push(...plan.unused);
      },
      async onClaimAudit() {
        const gate = await auditGate.get(user.id, created.id);
        const plan = planClaimAuditDecisions(gate, project.decisions.claimAudit, photoNames);
        try {
          for (const c of plan.claims) {
            await auditGate.decideClaim(user.id, created.id, c.claimId, c.request);
          }
          for (const i of plan.images) {
            await auditGate.decideImage(user.id, created.id, i.artifactId, i.request);
          }
        } catch (error) {
          throw describeGateError(error);
        }
        const approved = await auditGate.approve(user.id, created.id);
        gates.claimAudit = {
          stopReason: approved.stopReason,
          passes: approved.passes.length,
          flaggedClaims: approved.counts.flaggedClaims,
          claims: plan.claims.map((c) => ({
            variant: c.variant,
            position: c.position,
            flags: c.flags,
            choice: c.request.choice,
            origin: c.origin,
          })),
          images: plan.images.map((i) => ({
            photo: i.photo,
            operationId: i.operationId,
            choice: i.request.choice,
            origin: i.origin,
          })),
          integrityFallbacks: approved.integrityFallbacks.length,
          warnings: approved.warnings.map((w) =>
            w.kind === 'variant_empty'
              ? `variant_empty ${w.variant}`
              : `${w.kind} ${w.variant} ${w.factKey}`,
          ),
        };
        gates.unused.push(...plan.unused);
      },
    }).catch(async (error: unknown) => {
      // A scripted decision that does not fit the run leaves it waiting at its gate: report it
      // with the run's cost so far instead of losing the summary.
      if (!(error instanceof ScriptedDecisionError)) throw error;
      scriptFailure = error.message;
      const current = await getRun(db, created.id);
      if (current === undefined) throw error;
      return current;
    });
    if (run.status === 'completed' && gates.factConflicts === null) {
      gates.factConflicts = { conflictCount: 0, conflicts: [], decisions: [] };
    }

    const exported =
      run.status === 'completed' ? await writeExport(db, storage, run.id, options.outDir) : null;
    const summary = await buildSummary(db, run, project.service, {
      scriptFailure,
      mode,
      cassette: mode === 'live' ? null : cassette,
      startedAt,
      gates,
      exported,
      replay,
      aliases,
    });
    await writeFile(
      path.join(options.outDir, SUMMARY_FILE),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );
    return summary;
  } finally {
    // pg-boss first (in-flight steps need the pool), then MSW (record mode writes the cassette),
    // then the container (Docker's HTTP API must not be intercepted).
    await boss?.stop({ graceful: false }).catch((error: unknown) => {
      logger.error({ err: error }, 'error while stopping pg-boss');
    });
    await replay?.stop();
    await testDb.stop();
    await rm(storageDir, { recursive: true, force: true });
  }
}

interface DriveOptions {
  readonly db: TestDatabase['db'];
  readonly timeoutMs: number;
  readonly progress: (line: string) => void;
  readonly onFactConflicts: () => Promise<void>;
  readonly onClaimAudit: () => Promise<void>;
}

/** Follows the run's events, applies the gates' scripted decisions, and returns the final run. */
async function driveRun(runId: string, options: DriveOptions): Promise<Run> {
  const deadline = Date.now() + options.timeoutMs;
  let seq = 0;
  const decided = new Set<string>();
  for (;;) {
    for (const event of await listRunEvents(options.db, runId, { afterSeq: seq })) {
      seq = event.seq;
      const line = eventLine(event.type, event.payload);
      if (line !== undefined) options.progress(line);
    }
    const run = await getRun(options.db, runId);
    if (run === undefined) throw new Error(`Run ${runId} disappeared`);
    if (run.status === 'completed' || run.status === 'failed') return run;
    if (run.status === 'awaiting_gate' && run.gate !== null && !decided.has(run.gate)) {
      decided.add(run.gate);
      if (run.gate === 'fact_conflicts') await options.onFactConflicts();
      else await options.onClaimAudit();
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Run ${runId} did not finish within ${options.timeoutMs / 60_000} minutes`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
