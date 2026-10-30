import type { Gate, GateConflict } from '@evidomo/shared';
import { PgBoss } from 'pg-boss';
import type { Database } from '../db/client.ts';
import { createProject } from '../db/repositories/projects.ts';
import { listRunEvents } from '../db/repositories/run-events.ts';
import { createRun, getRun, type Run } from '../db/repositories/runs.ts';
import type { DefinitionRegistry } from '../definitions/loader.ts';
import { ClaimAuditGateError, createClaimAuditGate } from '../gates/claim-audit.ts';
import { createFactConflictsGate, FactConflictsGateError } from '../gates/fact-conflicts.ts';
import type { Logger } from '../logger.ts';
import { createMetaClients } from '../meta/clients.ts';
import type { MatchOptions } from '../meta/fixtures.ts';
import { createMetaReplay, type MetaReplay, type MetaReplayOptions } from '../meta/replay.ts';
import type { UsageEntry, UsageRecorder } from '../meta/usage.ts';
import { createStepHandlers } from '../pipeline/handlers.ts';
import { createRunEngine } from '../runs/engine.ts';
import type { Storage } from '../storage/storage.ts';
import { createPriceTableCostEstimator } from '../usage/ledger.ts';
import {
  planClaimAuditDecisions,
  planFactConflictDecisions,
  ScriptedDecisionError,
  type PlannedConflictDecision,
} from './decisions.ts';
import { createFixtureImageAliases, type FixtureImageAliases } from './image-aliases.ts';
import { ingestPhoto, ingestVoiceMemo } from './ingest.ts';
import type { Project } from './project.ts';
import type { PipelineMode, PipelineSummary } from './summary.ts';
import { usd } from './summary.ts';

// The headless pipeline's core (P3-10, docs/architecture.md §5 "Headless pipeline CLI"): one
// validated project through the real run engine, step handlers, and gate services, against the
// database and storage the caller provides. `runPipeline` (`npm run pipeline`) gives it a
// throwaway Testcontainers database; `seedDemoRun` (`npm run demo:seed`) the configured one.
// Fixture mode replays a recorded run through MSW and cannot reach the network.

const POLL_MS = 250;

/** Where the run is written. */
export interface PipelineTarget {
  readonly db: Database;
  /** pg-boss's connection: the same database as `db`. */
  readonly bossConnectionString: string;
  /**
   * pg-boss schema for the run's jobs (default `pgboss`). A separate schema keeps the jobs away
   * from any other worker on the same database, which would otherwise execute them (live).
   */
  readonly bossSchema?: string;
  readonly storage: Storage;
  /** The owner of the project the run is created in. */
  readonly ownerId: string;
}

export interface ExecutePipelineOptions {
  readonly project: Project;
  readonly definitions: DefinitionRegistry;
  readonly mode: PipelineMode;
  /** Required by fixtures and record modes. */
  readonly cassette: string | null;
  /** Directory of `cassette` (default `fixtures/meta/`). */
  readonly fixturesDir?: string;
  /**
   * Record mode: keep every interaction of the cassette, not only this session's (a cassette
   * holding several recorded Gate 1 paths, `recorded-paths.ts`).
   */
  readonly retainUnused?: boolean;
  /** `MODEL_API_KEY` for live and record mode; never used in fixture mode. */
  readonly apiKey: string | undefined;
  /** Record mode reads its settings from here. */
  readonly env: NodeJS.ProcessEnv;
  readonly dailyCapUsd: string;
  readonly logger: Logger;
  readonly progress: (line: string) => void;
  readonly timeoutMs: number;
  readonly target: PipelineTarget;
  /**
   * Leave the run `awaiting_gate` at this gate, before any scripted decision for it is applied
   * (the development seed). The run stays resumable by the normal gate services.
   */
  readonly stopAtGate?: Gate;
  /**
   * Record mode: serve requests the cassette already answers (default true). False sends every
   * request live, repeats included (the eval's live mode).
   */
  readonly extend?: boolean;
  /** Further cassettes under `fixturesDir` served read-only (`MetaReplayOptions.include`). */
  readonly include?: readonly string[];
  /** Evaluation only (`npm run eval`): `MetaReplayOptions.rewriteResponse`; not in live mode. */
  readonly rewriteResponse?: MetaReplayOptions['rewriteResponse'];
  /** Sees every interaction after the image aliases did (`MetaReplayOptions.onInteraction`). */
  readonly onInteraction?: MetaReplayOptions['onInteraction'];
  /** Sees every metered model call, after the run's usage ledger recorded it. */
  readonly onUsage?: (entry: UsageEntry) => void;
}

/** What waits at the gate a run was left at (`stopAtGate`). */
export type StoppedAtGate =
  | {
      readonly gate: 'fact_conflicts';
      readonly conflictCount: number;
      readonly conflicts: readonly string[];
      /**
       * The decisions the project's script would make, one line per conflict, in gate order; null
       * when the script cannot decide them all. A run continued by a replay worker must be decided
       * the same way, because later requests are matched on the decided facts.
       */
      readonly scriptedDecisions: readonly string[] | null;
    }
  | {
      readonly gate: 'claim_audit';
      readonly openClaims: number;
      readonly openImages: number;
    };

export interface PipelineExecution {
  /** The run as it ended: completed, failed, or waiting at a gate after a script failure. */
  readonly run: Run;
  readonly scriptFailure: string | null;
  readonly gates: GateRecords;
  /** Set when the run was left at `stopAtGate`. */
  readonly stoppedAt: StoppedAtGate | null;
  /**
   * Gate 1 as the run reached it (sides in gate order), and the decisions applied there (null
   * when none were, e.g. the run stopped at the gate); null when the run never reached Gate 1.
   */
  readonly gate1: {
    readonly conflicts: readonly GateConflict[];
    readonly applied: readonly PlannedConflictDecision[] | null;
  } | null;
  /** Set in fixtures and record modes; stopped, its counters final. */
  readonly replay: MetaReplay | undefined;
  readonly aliases: FixtureImageAliases;
  /** Project file name per material ID. */
  readonly photoNames: ReadonlyMap<string, string>;
}

/**
 * How a project's cassette matches requests. Intake always sends the memo as `voice-memo.wav`;
 * the TTS walkthrough a run is recorded from may not be committed (docs/model-notes.md, P1-04),
 * so audio matches by name. Everything that replays a project's cassette must use these options.
 */
export function fixtureMatchOptions(aliases: FixtureImageAliases): MatchOptions {
  return { ignoreFileContentFields: ['audio'], imageAlias: aliases.alias };
}

function tapUsage(usage: UsageRecorder, onUsage: ((entry: UsageEntry) => void) | undefined) {
  if (onUsage === undefined) return usage;
  return {
    record(entry: UsageEntry) {
      usage.record(entry);
      onUsage(entry);
    },
  } satisfies UsageRecorder;
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

export interface GateRecords {
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

/**
 * Creates the project and its inputs for `target.ownerId`, starts the run, applies the scripted
 * gate decisions, and returns once the run completed, failed, or a decision could not be made
 * (`ScriptedDecisionError`; the run then waits at its gate). pg-boss and the replay are stopped
 * before it returns, in that order (in-flight steps need the pool; record mode writes the
 * cassette on stop). Database and storage stay the caller's.
 */
export async function executePipeline(options: ExecutePipelineOptions): Promise<PipelineExecution> {
  const { mode, env, logger, progress, project, definitions, cassette, target } = options;
  if (mode !== 'live' && cassette === null) {
    // Without a cassette nothing would intercept the requests: never run "fixtures" live.
    throw new Error(`${mode} mode needs a cassette`);
  }
  if (mode === 'live' && (options.rewriteResponse !== undefined || options.include !== undefined)) {
    // Both work through the replay, which live mode does not start.
    throw new Error('rewriteResponse and include need fixtures or record mode');
  }
  const apiKey = options.apiKey;
  const aliases = createFixtureImageAliases();
  let replay: MetaReplay | undefined;
  let boss: PgBoss | undefined;
  try {
    if (mode !== 'live' && cassette !== null) {
      replay = createMetaReplay({
        cassette,
        ...(options.fixturesDir === undefined ? {} : { fixturesDir: options.fixturesDir }),
        mode: mode === 'record' ? 'record' : 'replay',
        env,
        extend: mode === 'record' && options.extend !== false,
        retainUnused: options.retainUnused === true,
        match: fixtureMatchOptions(aliases),
        ...(options.include === undefined ? {} : { include: options.include }),
        ...(options.rewriteResponse === undefined
          ? {}
          : { rewriteResponse: options.rewriteResponse }),
        onInteraction: async (interaction, context) => {
          await aliases.onInteraction(interaction);
          await options.onInteraction?.(interaction, context);
        },
      });
      await replay.start();
    }
    const { db, storage } = target;
    boss = new PgBoss({
      connectionString: target.bossConnectionString,
      ...(target.bossSchema === undefined ? {} : { schema: target.bossSchema }),
    });
    boss.on('error', (error) => {
      logger.error({ err: error }, 'pg-boss error');
    });
    await boss.start();
    const estimateCost = createPriceTableCostEstimator();
    const clientKey = replay?.apiKey ?? apiKey;
    const engine = createRunEngine({
      db,
      boss,
      registry: definitions,
      logger,
      dailyCapUsd: options.dailyCapUsd,
      handlers: createStepHandlers({ storage, markets: definitions }),
      createMetaClients: (usage) =>
        createMetaClients({
          apiKey: clientKey,
          usage: tapUsage(usage, options.onUsage),
          estimateCost,
          logger,
        }),
    });
    await engine.startWorkers({ pollingIntervalSeconds: 0.5 });
    const factGate = createFactConflictsGate({ db, engine, markets: definitions });
    const auditGate = createClaimAuditGate({ db, engine, markets: definitions });

    const user = { id: target.ownerId };
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
    let stoppedAt: StoppedAtGate | null = null;
    let gate1: PipelineExecution['gate1'] = null;
    const run = await driveRun(created.id, {
      db,
      timeoutMs: options.timeoutMs,
      progress,
      stopAtGate: options.stopAtGate,
      async onStop(gateName) {
        if (gateName === 'fact_conflicts') {
          const gate = await factGate.get(user.id, created.id);
          gate1 = { conflicts: gate.conflicts, applied: null };
          const conflicts = gate.conflicts.map((c) => `${c.id} ${c.key}`);
          gates.factConflicts = { conflictCount: gate.conflictCount, conflicts, decisions: [] };
          let scriptedDecisions: string[] | null = null;
          try {
            const plan = planFactConflictDecisions(gate, project.decisions.factConflicts);
            scriptedDecisions = plan.decisions.map((d) => `${d.conflictId} ${d.key}: ${d.label}`);
          } catch (error) {
            if (!(error instanceof ScriptedDecisionError)) throw error;
          }
          stoppedAt = {
            gate: 'fact_conflicts',
            conflictCount: gate.conflictCount,
            conflicts,
            scriptedDecisions,
          };
          return;
        }
        const gate = await auditGate.get(user.id, created.id);
        stoppedAt = {
          gate: 'claim_audit',
          openClaims: gate.counts.openClaims,
          openImages: gate.counts.openImages,
        };
      },
      async onFactConflicts() {
        const gate = await factGate.get(user.id, created.id);
        gate1 = { conflicts: gate.conflicts, applied: null };
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
        gate1 = { conflicts: gate.conflicts, applied: plan.decisions };
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
    return { run, scriptFailure, gates, stoppedAt, gate1, replay, aliases, photoNames };
  } finally {
    await boss?.stop({ graceful: false }).catch((error: unknown) => {
      logger.error({ err: error }, 'error while stopping pg-boss');
    });
    await replay?.stop();
  }
}

interface DriveOptions {
  readonly db: Database;
  readonly timeoutMs: number;
  readonly progress: (line: string) => void;
  readonly stopAtGate: Gate | undefined;
  readonly onStop: (gate: Gate) => Promise<void>;
  readonly onFactConflicts: () => Promise<void>;
  readonly onClaimAudit: () => Promise<void>;
}

/**
 * Follows the run's events, applies the gates' scripted decisions, and returns the final run, or
 * the run waiting at `stopAtGate` with that gate's decisions untouched.
 */
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
    if (run.status === 'awaiting_gate' && run.gate !== null && run.gate === options.stopAtGate) {
      await options.onStop(run.gate);
      return run;
    }
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
