import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { usdAmountSchema, type GateConflict } from '@evidomo/shared';
import { createUser } from '../db/repositories/users.ts';
import { startTestDatabase } from '../db/testing.ts';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import type { Logger } from '../logger.ts';
import { DEV_REPLAY_DAILY_CAP_USD } from '../cli/dev-seed-run.ts';
import { executePipeline } from '../cli/execute.ts';
import { loadProject, withVoiceMemo, type Project } from '../cli/project.ts';
import {
  cassettePath,
  FIXTURE_FORMAT_VERSION,
  META_FIXTURES_DIR,
  readCassette,
  writeCassette,
  type Interaction,
} from '../meta/fixtures.ts';
import type { UsageEntry } from '../meta/usage.ts';
import { createLocalStorage } from '../storage/local.ts';
import {
  observedBasisNotes,
  observedClaims,
  observedConflicts,
  runUsage,
  type RunUsage,
} from './collect.ts';
import type { AppliedInjection, SkippedInjection } from './inject.ts';
import { createInjectionRewrite } from './rewrite.ts';
import { interactionResponseId, liveUsage } from './spend.ts';
import { scoreSet, totals, type EvalTotals, type SetScore } from './score.ts';
import { loadEvalSets, selectEvalSets, type EvalSet } from './sets.ts';

// `npm run eval` (docs/architecture.md §12 "Seeded-defect eval"): every seeded set through the
// real pipeline (`executePipeline`: run engine, step handlers, gate services, export) on one
// throwaway PostgreSQL, with the set's defects injected into the creative and Q&A steps' first
// answers, then scored against the set's answer key.
//
// - fixtures (default): the set's cassette plus its read-only includes, through MSW; no request
//   can leave the process.
// - record: live through the recorder into the set's cassette; requests the includes or the
//   cassette already answer are served from them, so a set pays only for what it changes.
// - live: every request live, repeats included (through the recorder into a scratch cassette
//   under --out, never committed), except the voice memo's transcription, which is served
//   read-only from the set's recordings because the walkthrough audio is not committed; pass
//   --voice-memo to transcribe it live too.

export const EVAL_MODES = ['fixtures', 'record', 'live'] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

export interface RunEvalOptions {
  readonly mode: EvalMode;
  /** Set IDs to run; all when empty. */
  readonly sets: readonly string[];
  /** Live spend cap for record and live modes (USD, exact decimal). */
  readonly maxUsd: string;
  /** Scratch directory for live mode's cassettes. */
  readonly outDir: string;
  readonly voiceMemo?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logger: Logger;
  readonly progress: (line: string) => void;
  readonly timeoutMs?: number;
  readonly setsDir?: string;
  readonly definitionsDir?: string;
  readonly fixturesDir?: string;
}

export class EvalUsageError extends Error {
  override name = 'EvalUsageError';
}

export interface SetRun {
  readonly id: string;
  readonly title: string;
  /** Null when the set failed before its run could be read. */
  readonly runId: string | null;
  readonly status: string;
  readonly failureReason: string | null;
  readonly gate1Conflicts: number;
  readonly applied: readonly AppliedInjection[];
  readonly skipped: readonly SkippedInjection[];
  /** First-draft copy and Q&A answers the rewrite saw. */
  readonly draftsSeen: { readonly copy: number; readonly qa: number };
  readonly passes: number | null;
  readonly stopReason: string | null;
  readonly score: SetScore;
  readonly usage: RunUsage;
  /** Gate 1 as the run reached it: key, deciders, and per side the facts' source and value. */
  readonly conflicts: readonly ConflictSummary[];
  /** Spend of the requests that went to the live API in this set (0 in fixture mode). */
  readonly liveSpendUsd: number;
  /** Metered calls answered live, and their summed wall-clock time (0 in fixture mode). */
  readonly liveCalls: number;
  readonly liveLatencyMs: number;
  readonly network: {
    readonly liveRequests: number;
    readonly servedFromCassette: number;
    readonly unmatched: readonly string[];
  };
  readonly wallMs: number;
}

export interface ConflictSummary {
  readonly id: string;
  readonly key: string;
  readonly detectedBy: readonly string[];
  /** Per side, `<source kind>:<key>=<value>` per fact. */
  readonly sides: readonly (readonly string[])[];
}

function summarizeConflicts(conflicts: readonly GateConflict[]): ConflictSummary[] {
  return conflicts.map((c) => ({
    id: c.id,
    key: c.key,
    detectedBy: [...c.detectedBy],
    sides: c.sides.map((side) => [
      ...new Set(side.facts.map((f) => `${f.source.kind}:${f.key}=${JSON.stringify(f.value)}`)),
    ]),
  }));
}

function errorRun(
  set: EvalSet,
  reason: string,
  rewrite: ReturnType<typeof createInjectionRewrite>,
  live: { costUsd: number; calls: number; latencyMs: number },
  wallMs: number,
): SetRun {
  return {
    id: set.id,
    title: set.title,
    runId: null,
    status: 'error',
    failureReason: reason,
    gate1Conflicts: 0,
    applied: rewrite.applied(),
    skipped: rewrite.skipped(),
    draftsSeen: { ...rewrite.seen },
    passes: null,
    stopReason: null,
    score: scoreSet({
      expectations: set,
      conflicts: [],
      basisNotes: [],
      applied: [],
      skipped: [],
      claims: null,
    }),
    usage: { runCostUsd: '0', calls: 0, latencyMs: 0, steps: [] },
    conflicts: [],
    liveSpendUsd: live.costUsd,
    liveCalls: live.calls,
    liveLatencyMs: live.latencyMs,
    network: { liveRequests: 0, servedFromCassette: 0, unmatched: [] },
    wallMs,
  };
}

export interface EvalReport {
  readonly mode: EvalMode;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly sets: readonly SetRun[];
  /** Sets not run because the next one could exceed `maxUsd`. */
  readonly skippedForBudget: readonly string[];
  readonly totals: EvalTotals;
  readonly liveSpendUsd: number;
  readonly maxUsd: string | null;
}

const OPERATOR_EMAIL = 'eval@example.invalid';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const INTAKE_PATH = '/v1/asr/transcribe';

/** Live mode: a scratch cassette holding only the intake transcriptions of the set's recordings. */
async function seedLiveCassette(set: EvalSet, file: string, fixturesDir: string): Promise<void> {
  const intake: Interaction[] = [];
  for (const name of [...set.include, set.cassette]) {
    const cassette = await readCassette(cassettePath(name, fixturesDir));
    intake.push(...cassette.interactions.filter((i) => i.request.path === INTAKE_PATH));
  }
  if (intake.length === 0) {
    throw new EvalUsageError(
      `Set ${set.id} has no recorded transcription to serve in live mode; pass --voice-memo`,
    );
  }
  await writeCassette(file, {
    formatVersion: FIXTURE_FORMAT_VERSION,
    cassette: `live/${set.id}`,
    recordedAt: new Date().toISOString(),
    interactions: intake,
  });
}

async function loadSetProject(
  set: EvalSet,
  definitions: DefinitionRegistry,
  voiceMemo: string | undefined,
): Promise<Project> {
  const project = await loadProject(set.projectDir, definitions, (id, version) =>
    definitions.getService(id, version),
  );
  return voiceMemo === undefined ? project : withVoiceMemo(project, voiceMemo);
}

export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const startedAt = Date.now();
  const { mode, env, logger, progress } = options;
  const maxUsd = usdAmountSchema.safeParse(options.maxUsd);
  if (!maxUsd.success) throw new EvalUsageError('--max-usd must be a decimal amount');
  const cap = Number(maxUsd.data);
  const apiKey = env['MODEL_API_KEY'];
  if (mode !== 'fixtures' && (apiKey === undefined || apiKey === '')) {
    throw new EvalUsageError(`${mode} mode needs MODEL_API_KEY in the environment`);
  }
  const fixturesDir = options.fixturesDir ?? META_FIXTURES_DIR;
  const definitions = await loadDefinitions(options.definitionsDir);
  const sets = selectEvalSets(await loadEvalSets(options.setsDir), options.sets);
  const projects = new Map<string, Project>();
  for (const set of sets) {
    projects.set(set.id, await loadSetProject(set, definitions, options.voiceMemo));
  }

  progress(`Starting PostgreSQL (Testcontainers) for ${sets.length} eval set(s) ...`);
  const testDb = await startTestDatabase();
  const storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-eval-'));
  const results: SetRun[] = [];
  const skippedForBudget: string[] = [];
  let spent = 0;
  try {
    const { db } = testDb;
    const storage = createLocalStorage({ rootDir: storageDir });
    const user = await createUser(db, { email: OPERATOR_EMAIL, passwordHash: 'not-a-login' });
    for (const set of sets) {
      const project = projects.get(set.id);
      if (project === undefined) throw new Error(`No project for set ${set.id}`);
      const runCap = Number(project.service.budget.max_cost_usd_per_run);
      if (mode !== 'fixtures' && spent + runCap > cap) {
        // The per-run cap bounds what the next set can spend; never start one that could cross
        // the eval's cap.
        progress(
          `Skipping ${set.id}: spent ${spent.toFixed(4)} USD, and a run may cost up to ` +
            `${runCap.toFixed(2)} (cap ${maxUsd.data})`,
        );
        skippedForBudget.push(set.id);
        continue;
      }
      progress(`\n== ${set.id}: ${set.title} (${mode})`);
      const rewrite = createInjectionRewrite(set.injections);
      const usage: UsageEntry[] = [];
      const liveIds = new Map<string, number>();
      let liveImageRequests = 0;
      let cassette = set.cassette;
      let include: readonly string[] = set.include;
      let setFixturesDir = fixturesDir;
      if (mode === 'live') {
        setFixturesDir = path.join(options.outDir, 'cassettes');
        cassette = `live/${set.id}`;
        await mkdir(path.join(setFixturesDir, 'live'), { recursive: true });
        await rm(cassettePath(cassette, setFixturesDir), { force: true });
        include = [];
        if (options.voiceMemo === undefined) {
          const seed = `live/${set.id}-intake`;
          await seedLiveCassette(set, cassettePath(seed, setFixturesDir), fixturesDir);
          include = [seed];
        }
      }
      const setStarted = Date.now();
      const measureLive = () =>
        mode === 'fixtures'
          ? { costUsd: 0, calls: 0, latencyMs: 0 }
          : liveUsage(usage, { responseIds: liveIds, imageRequests: liveImageRequests });
      let execution: Awaited<ReturnType<typeof executePipeline>>;
      try {
        execution = await executePipeline({
          project,
          definitions,
          mode: mode === 'fixtures' ? 'fixtures' : 'record',
          cassette,
          fixturesDir: setFixturesDir,
          include,
          // Live mode sends every request, repeats included; record mode pays only for new ones.
          extend: mode !== 'live',
          rewriteResponse: rewrite.rewriteResponse,
          onInteraction: (interaction, context) => {
            if (context.fromCassette) return;
            const id = interactionResponseId(interaction);
            if (id !== undefined) liveIds.set(id, (liveIds.get(id) ?? 0) + 1);
            if (interaction.request.path.startsWith('/v1/images/')) liveImageRequests += 1;
          },
          onUsage: (entry) => usage.push(entry),
          apiKey,
          env,
          dailyCapUsd: mode === 'live' ? maxUsd.data : DEV_REPLAY_DAILY_CAP_USD,
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
      } catch (error) {
        // A set that cannot finish (e.g. record mode captured nothing) is reported, and the
        // spend it caused still counts; the remaining sets run.
        const live = measureLive();
        spent += live.costUsd;
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        progress(`   ${set.id}: error, live spend ${live.costUsd.toFixed(4)} USD: ${reason}`);
        results.push(errorRun(set, reason, rewrite, live, Date.now() - setStarted));
        continue;
      }
      const { run, replay } = execution;
      const live = measureLive();
      const setSpend = live.costUsd;
      spent += setSpend;
      const claims = await observedClaims(db, storage, run.id);
      const score = scoreSet({
        expectations: set,
        conflicts: observedConflicts(execution.gate1?.conflicts ?? []),
        basisNotes: await observedBasisNotes(db, run.id),
        applied: rewrite.applied(),
        skipped: rewrite.skipped(),
        claims,
      });
      results.push({
        id: set.id,
        title: set.title,
        runId: run.id,
        status: run.status,
        failureReason: run.failureReason ?? execution.scriptFailure,
        gate1Conflicts: execution.gate1?.conflicts.length ?? 0,
        applied: rewrite.applied(),
        skipped: rewrite.skipped(),
        draftsSeen: { ...rewrite.seen },
        passes: claims?.passes ?? null,
        stopReason: claims?.stopReason ?? null,
        score,
        usage: await runUsage(db, run.id),
        conflicts: summarizeConflicts(execution.gate1?.conflicts ?? []),
        liveSpendUsd: setSpend,
        liveCalls: live.calls,
        liveLatencyMs: live.latencyMs,
        network: {
          liveRequests: replay?.liveRequestCount ?? 0,
          servedFromCassette: replay?.servedFromCassetteCount ?? 0,
          unmatched: [...(replay?.unmatched ?? [])],
        },
        wallMs: Date.now() - setStarted,
      });
      progress(
        `   ${set.id}: ${run.status}, live spend ${setSpend.toFixed(4)} USD ` +
          `(eval total ${spent.toFixed(4)})`,
      );
    }
  } finally {
    await testDb.stop();
    await rm(storageDir, { recursive: true, force: true });
  }
  return {
    mode,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    sets: results,
    skippedForBudget,
    totals: totals(results.map((r) => r.score)),
    liveSpendUsd: spent,
    maxUsd: mode === 'fixtures' ? null : maxUsd.data,
  };
}
