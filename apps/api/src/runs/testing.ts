// Test support for the run engine: synthetic service definitions, a registry, fake step
// handlers, and polling. Imported only by tests and by the crash-test child worker.
import { serviceDefinitionSchema, type ServiceDefinition, type ServiceStep } from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import type { Executor } from '../db/client.ts';
import { DefinitionNotFoundError, type DefinitionRegistry } from '../definitions/loader.ts';
import { createMetaClients, type MetaClients } from '../meta/clients.ts';
import type { UsageRecorder } from '../meta/usage.ts';
import type { StepContext, StepHandlers, StepResult } from './steps.ts';

/** A model call's usage as the fake handlers report it: 1,000 in + 500 out on Spark. */
export const FAKE_MODEL_ID = 'muse-spark-1.3';

type StepSpec =
  | { id: string; agent: 'intake'; gate_after?: ServiceStep['gate_after'] }
  | {
      id: string;
      agent: 'extractor' | 'reconciler' | 'qa_writer';
      gate_after?: ServiceStep['gate_after'];
    }
  | { id: string; agent: 'exporter'; gate_after?: ServiceStep['gate_after'] };

function stepFrom(spec: StepSpec): unknown {
  const gate = spec.gate_after === undefined ? {} : { gate_after: spec.gate_after };
  switch (spec.agent) {
    case 'intake':
      return {
        id: spec.id,
        agent: spec.agent,
        model: 'muse-voice-transcribe-1.0',
        transcription_mode: 'ENDPOINTING',
        ...gate,
      };
    case 'exporter':
      return { id: spec.id, agent: spec.agent, ...gate };
    default:
      return {
        id: spec.id,
        agent: spec.agent,
        model: FAKE_MODEL_ID,
        reasoning_effort: 'low',
        max_output_tokens: 1000,
        ...gate,
      };
  }
}

/** A valid service definition (validated by the real schema) with the given steps. */
export function buildTestService(
  id: string,
  steps: readonly StepSpec[],
  budgetUsd = '0.50',
): ServiceDefinition {
  return serviceDefinitionSchema.parse({
    id,
    version: 1,
    name: `Test service ${id}`,
    inputs: [
      {
        key: 'facts',
        type: 'form',
        schema: 'from_market_profile',
        source_of_truth: true,
        required: true,
      },
    ],
    steps: steps.map(stepFrom),
    budget: { max_cost_usd_per_run: budgetUsd },
  });
}

export function testRegistry(
  ...services: ServiceDefinition[]
): Pick<DefinitionRegistry, 'getService' | 'services'> {
  return {
    services,
    getService(id, version) {
      const found = services.find((s) => s.id === id && s.version === version);
      if (found === undefined) {
        throw new DefinitionNotFoundError(`No service definition "${id}" version ${version}`);
      }
      return found;
    },
  };
}

/** Real Meta clients with a placeholder key: fakes only use `recordUsage`, never the network. */
export function placeholderMetaClients(usage: UsageRecorder): MetaClients {
  return createMetaClients({ apiKey: 'test-placeholder-key', usage });
}

/** One metered "model call" that bills 1,000 input and 500 output tokens and calls nothing. */
export async function fakeModelCall(context: StepContext): Promise<void> {
  await context.ledger.meter(FAKE_MODEL_ID, () => {
    context.metaClients().recordUsage({
      sdk: 'ai-sdk',
      modelId: FAKE_MODEL_ID,
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 500,
      reasoningTokens: 0,
      totalTokens: 1500,
      responseId: undefined,
      latencyMs: 1,
    });
    return Promise.resolve();
  });
}

/** The same handler for every agent; it dispatches on `context.step.id` or the run. */
export function uniformHandlers(
  handler: (context: StepContext) => Promise<StepResult | undefined>,
): StepHandlers {
  return {
    intake: handler,
    extractor: handler,
    vision: handler,
    reconciler: handler,
    creative: handler,
    qa_writer: handler,
    stager: handler,
    integrity_checker: handler,
    verifier: handler,
    exporter: handler,
  };
}

/** Resolves when the signal aborts, rejecting with its reason. */
export function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('Aborted'));
    };
    if (signal.aborted) fail();
    signal.addEventListener('abort', fail, { once: true });
  });
}

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/** Polls `probe` until it returns a value other than `undefined`; fails after the timeout. */
export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined>,
  options: WaitOptions = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const intervalMs = options.intervalMs ?? 50;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------------------------
// Crash test: the child worker's service, invocation log, and handlers
// ---------------------------------------------------------------------------------------------

export const CRASH_SERVICE = buildTestService('crash-test', [
  { id: 'intake', agent: 'intake' },
  { id: 'extract', agent: 'extractor' },
  { id: 'export', agent: 'exporter' },
]);

/**
 * Step-job timing for the crash test and its child workers. Whoever enqueues a step sets these
 * on the job, so the test process and the children must agree.
 */
export const CRASH_TEST_TIMING = {
  // Long enough that the engine's own timeout never fires during the test.
  stepTimeoutMs: 60_000,
  expiryGraceSeconds: 30,
  // pg-boss minimum: a SIGKILLed worker's job is retried about 10 s after its last heartbeat.
  heartbeatSeconds: 10,
  retryDelaySeconds: 0,
} as const;

/** The step the crash test interrupts: each invocation waits until the test releases it. */
export const CRASH_SLOW_STEP = 'extract';

/** Test-only table (not in migrations): one row per handler invocation, from any process. */
export async function createInvocationLog(db: Executor): Promise<void> {
  await db.execute(sql`
    create table if not exists test_step_invocations (
      run_id uuid not null,
      step_id text not null,
      n int not null,
      pid int not null,
      released boolean not null default false,
      primary key (run_id, step_id, n)
    )
  `);
}

export interface Invocation {
  stepId: string;
  n: number;
  pid: number;
}

export async function listInvocations(db: Executor, runId: string): Promise<Invocation[]> {
  const result = await db.execute<{ step_id: string; n: number; pid: number }>(
    sql`select step_id, n, pid from test_step_invocations where run_id = ${runId} order by step_id, n`,
  );
  return result.rows.map((row) => ({ stepId: row.step_id, n: row.n, pid: row.pid }));
}

export async function releaseInvocation(
  db: Executor,
  runId: string,
  stepId: string,
  n: number,
): Promise<void> {
  await db.execute(sql`
    update test_step_invocations set released = true
    where run_id = ${runId} and step_id = ${stepId} and n = ${n}
  `);
}

/**
 * Every invocation is logged with its process ID and bills one fake model call. The slow step
 * then blocks until the test releases that invocation (or the step is aborted), so the test
 * decides exactly when it may finish: no sleeps, no timing races.
 */
export function crashTestHandlers(): StepHandlers {
  return uniformHandlers(async (context) => {
    const { db, run, step, signal } = context;
    const inserted = await db.execute<{ n: number }>(sql`
      insert into test_step_invocations (run_id, step_id, n, pid)
      select ${run.id}, ${step.id}, coalesce(max(n), 0) + 1, ${process.pid}
      from test_step_invocations where run_id = ${run.id} and step_id = ${step.id}
      returning n
    `);
    const n = inserted.rows[0]?.n;
    if (n === undefined) throw new Error('invocation was not logged');
    await fakeModelCall(context);
    if (step.id !== CRASH_SLOW_STEP) return undefined;
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const released = await db.execute<{ released: boolean }>(sql`
        select released from test_step_invocations
        where run_id = ${run.id} and step_id = ${step.id} and n = ${n}
      `);
      if (released.rows[0]?.released === true) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
}
