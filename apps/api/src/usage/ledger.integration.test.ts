import { randomUUID } from 'node:crypto';
import { parsePriceTable } from '@evidomo/shared';
import { generateText } from 'ai';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteProject } from '../db/repositories/projects.ts';
import { getCostUsdSince, getRunCostUsd, listUsageForRun } from '../db/repositories/usage.ts';
import { usageLedger } from '../db/schema.ts';
import { createUser } from '../db/repositories/users.ts';
import {
  seedProject,
  seedRun,
  seedRunWithParents,
  startTestDatabase,
  type TestDatabase,
} from '../db/testing.ts';
import { DEMO_OWNER_EMAIL } from '../demo/owner.ts';
import { createMetaClients } from '../meta/clients.ts';
import { createMetaReplay } from '../meta/replay.ts';
import type { UsageEntry } from '../meta/usage.ts';
import { BudgetExceededError, checkBudget, utcDayWindow } from './budget.ts';
import {
  createPriceTableCostEstimator,
  createUsageLedger,
  InvalidBudgetCapError,
  UnpricedModelError,
  UnpricedUsageError,
  UsageLedgerError,
  UsagePersistenceError,
  type UsageLedgerOptions,
} from './ledger.ts';

// Fake prices keep the cap arithmetic obvious: one default call (1,000 in + 2,000 out) costs
// 1,000 × 0.000001 + 2,000 × 0.000002 = 0.005 USD.
const FAKE_PRICES = parsePriceTable({
  'fake-llm': { billing: 'tokens', inputUsdPerToken: '0.000001', outputUsdPerToken: '0.000002' },
  'fake-image': { billing: 'images', usdPerImage: '0.05' },
  'fake-voice': { billing: 'audio_seconds', usdPerAudioSecond: '0.001' },
});
// High enough that run-cap tests never trip the daily cap with today's rows.
const UNLIMITED_DAILY = '9999';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb.stop();
});

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    sdk: 'ai-sdk',
    modelId: 'fake-llm',
    inputTokens: 1_000,
    cachedInputTokens: 0,
    outputTokens: 2_000,
    reasoningTokens: 1_500,
    totalTokens: 3_000,
    responseId: 'resp_test',
    latencyMs: 812.6,
    estimatedCostUsd: undefined,
    ...overrides,
  };
}

function ledgerFor(options: Partial<UsageLedgerOptions> & Pick<UsageLedgerOptions, 'runId'>) {
  return createUsageLedger({
    db: testDb.db,
    stepId: 'fact_extraction',
    dailyCapUsd: UNLIMITED_DAILY,
    prices: FAKE_PRICES,
    ...options,
  });
}

async function insertAt(createdAt: Date, estimatedCostUsd: string): Promise<void> {
  await testDb.db
    .insert(usageLedger)
    .values({ modelId: 'fake-llm', estimatedCostUsd, latencyMs: 1, createdAt });
}

describe('flush', () => {
  it('buffers synchronously and persists entries with run, step, units, and exact cost', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const ledger = ledgerFor({ runId: run.id });

    ledger.record(entry());
    ledger.record(
      entry({
        modelId: 'fake-image',
        inputTokens: undefined,
        outputTokens: undefined,
        reasoningTokens: undefined,
        images: 3,
      }),
    );
    ledger.record(
      entry({
        modelId: 'fake-voice',
        inputTokens: undefined,
        outputTokens: undefined,
        reasoningTokens: undefined,
        audioDurationMs: 183_251,
      }),
    );
    expect(ledger.pendingCount).toBe(3);
    expect(await listUsageForRun(testDb.db, run.id)).toEqual([]);

    const rows = await ledger.flush();

    expect(ledger.pendingCount).toBe(0);
    // One transaction: the rows share created_at, so compare as sets, not by list order.
    const persisted = await listUsageForRun(testDb.db, run.id);
    expect(persisted.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(rows[0]).toMatchObject({
      runId: run.id,
      stepId: 'fact_extraction',
      modelId: 'fake-llm',
      inputTokens: 1_000,
      outputTokens: 2_000,
      reasoningTokens: 1_500,
      // Reasoning is inside output: 0.001 + 0.004, not + 0.003 more.
      estimatedCostUsd: '0.00500000',
      latencyMs: 813,
    });
    expect(rows[1]).toMatchObject({ images: 3, inputTokens: 0, estimatedCostUsd: '0.15000000' });
    expect(rows[2]).toMatchObject({ audioSeconds: '183.251', estimatedCostUsd: '0.18325100' });
    expect(await getRunCostUsd(testDb.db, run.id)).toBe('0.33825100');
    expect(await ledger.flush()).toEqual([]);
  });

  it('treats a reported zero as a real count', async () => {
    const ledger = ledgerFor({ runId: null, stepId: null });
    ledger.record(entry({ reasoningTokens: 0, outputTokens: 0, inputTokens: 0 }));
    const [row] = await ledger.flush();
    expect(row).toMatchObject({ runId: null, stepId: null, estimatedCostUsd: '0.00000000' });
  });

  it('fails loudly on unpriced calls after persisting the priceable ones', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const ledger = ledgerFor({ runId: run.id });
    ledger.record(entry());
    ledger.record(entry({ modelId: 'mystery-model' }));
    ledger.record(entry({ outputTokens: undefined }));
    ledger.record(entry({ modelId: 'fake-image', images: -2 }));

    const error = await ledger.flush().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UnpricedUsageError);
    if (!(error instanceof UnpricedUsageError)) return;
    expect(error.problems).toEqual([
      { modelId: 'mystery-model', reason: 'unknown_model', fields: [] },
      { modelId: 'fake-llm', reason: 'missing_units', fields: ['outputTokens'] },
      { modelId: 'fake-image', reason: 'invalid_units', fields: ['images'] },
    ]);
    expect(error.persisted).toHaveLength(1);
    expect(await getRunCostUsd(testDb.db, run.id)).toBe('0.00500000');
    expect(ledger.pendingCount).toBe(0);
  });

  it('surfaces persistence errors and keeps the entries buffered for a retry', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const ledger = ledgerFor({ runId: run.id });
    // 1,000,000 images × 0.05 = 50,000 USD: beyond the ledger's numeric(12, 8), so the insert
    // fails. (A missing run no longer fails it; see the next test.)
    const unstorable = entry({
      modelId: 'fake-image',
      inputTokens: undefined,
      outputTokens: undefined,
      reasoningTokens: undefined,
      images: 1_000_000,
    });
    ledger.record(entry());
    ledger.record(unstorable);

    const error = await ledger.flush().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UsagePersistenceError);
    expect(error).toMatchObject({ entryCount: 2, cause: expect.any(Error) as unknown });
    expect(ledger.pendingCount).toBe(2);
    await expect(ledger.flush()).rejects.toBeInstanceOf(UsagePersistenceError);
    expect(ledger.pendingCount).toBe(2);
    // All or nothing: the storable entry of the batch was not written either.
    expect(await listUsageForRun(testDb.db, run.id)).toEqual([]);
  });

  it('keeps a call whose run was deleted meanwhile, without the run, in the daily total', async () => {
    const { project, run } = await seedRunWithParents(testDb.db);
    const warn = vi.fn();
    const ledger = ledgerFor({ runId: run.id, logger: { warn } });
    const since = new Date(Date.now() - 1000);
    const before = await getCostUsdSince(testDb.db, since);
    // The project is deleted while the call is in flight (P5-04).
    await deleteProject(testDb.db, project.id);
    ledger.record(entry());

    const [row, ...rest] = await ledger.flush();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      runId: null,
      stepId: 'fact_extraction',
      estimatedCostUsd: '0.00500000',
    });
    expect(ledger.pendingCount).toBe(0);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { runId: run.id, rowCount: 1 },
      'run missing: usage recorded without its run',
    );
    const after = await getCostUsdSince(testDb.db, since);
    expect(Number(after) - Number(before)).toBeCloseTo(0.005, 8);
  });
});

describe('meter', () => {
  it('refuses a model without a price before the call', async () => {
    const ledger = ledgerFor({ runId: null });
    const call = vi.fn(() => Promise.resolve('never'));
    await expect(ledger.meter('mystery-model', call)).rejects.toBeInstanceOf(UnpricedModelError);
    expect(call).not.toHaveBeenCalled();
  });

  it('stops work at the per-run cap with an explicit error', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const ledger = ledgerFor({ runId: run.id, runCapUsd: '0.010' });
    const call = vi.fn(() => {
      ledger.record(entry());
      return Promise.resolve('answer');
    });

    expect(await ledger.meter('fake-llm', call)).toBe('answer'); // spent 0.005
    expect(await ledger.meter('fake-llm', call)).toBe('answer'); // spent 0.010
    const error = await ledger.meter('fake-llm', call).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error).toMatchObject({ kind: 'run', limitUsd: '0.010', spentUsd: '0.01000000' });
    expect(call).toHaveBeenCalledTimes(2);
    expect(await getRunCostUsd(testDb.db, run.id)).toBe('0.01000000');
  });

  it('lets the last call that passed the check overshoot the cap by at most its own cost', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const ledger = ledgerFor({ runId: run.id, runCapUsd: '0.007' });
    const call = vi.fn(() => {
      ledger.record(entry());
      return Promise.resolve('answer');
    });

    await ledger.meter('fake-llm', call); // 0.005 < 0.007
    await ledger.meter('fake-llm', call); // passed at 0.005, lands at 0.010
    await expect(ledger.meter('fake-llm', call)).rejects.toMatchObject({
      kind: 'run',
      spentUsd: '0.01000000',
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('stops work at the global daily cap, counting calls outside runs', async () => {
    const now = new Date('2099-05-01T09:00:00.000Z');
    await insertAt(new Date('2099-05-01T01:00:00.000Z'), '2.00');
    const ledger = ledgerFor({ runId: null, dailyCapUsd: '2.00', now: () => now });
    const call = vi.fn(() => Promise.resolve('never'));

    await expect(ledger.meter('fake-llm', call)).rejects.toMatchObject({
      name: 'BudgetExceededError',
      kind: 'daily',
      limitUsd: '2.00',
      spentUsd: '2.00000000',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('persists usage when the call fails after the model answered', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const ledger = ledgerFor({ runId: run.id });
    const failure = new Error('structured output did not match the schema');

    await expect(
      ledger.meter('fake-llm', () => {
        ledger.record(entry());
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
    expect(await getRunCostUsd(testDb.db, run.id)).toBe('0.00500000');
  });

  it('reports both errors when the call fails and its usage cannot be persisted', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const ledger = ledgerFor({ runId: run.id });
    const failure = new Error('model call failed');

    const error = await ledger
      .meter('fake-llm', () => {
        // Beyond the ledger's numeric(12, 8), so the insert fails.
        ledger.record(
          entry({
            modelId: 'fake-image',
            inputTokens: undefined,
            outputTokens: undefined,
            reasoningTokens: undefined,
            images: 1_000_000,
          }),
        );
        return Promise.reject(failure);
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) return;
    expect(error.errors[0]).toBe(failure);
    expect(error.errors[1]).toBeInstanceOf(UsagePersistenceError);
  });

  it('validates its configuration', () => {
    expect(() => ledgerFor({ runId: null, runCapUsd: '0.50' })).toThrow(UsageLedgerError);
    for (const dailyCapUsd of ['-1', '1000000.00']) {
      expect(() => ledgerFor({ runId: null, dailyCapUsd })).toThrow(
        expect.objectContaining({ name: 'InvalidBudgetCapError', cap: 'daily' }),
      );
    }
    expect(() => ledgerFor({ runId: randomUUID(), runCapUsd: '0.5000000001' })).toThrow(
      InvalidBudgetCapError,
    );
  });
});

describe('daily window', () => {
  it('uses the UTC calendar day, not Europe/Amsterdam', async () => {
    // 23:30 UTC on the 9th is already 00:30 on the 10th in Amsterdam; it belongs to the 9th.
    await insertAt(new Date('2099-03-09T23:30:00.000Z'), '0.70');
    await insertAt(new Date('2099-03-10T00:00:00.000Z'), '0.40');
    await insertAt(new Date('2099-03-10T23:59:59.999Z'), '0.05');

    expect(utcDayWindow(new Date('2099-03-10T18:00:00.000Z'))).toEqual({
      start: new Date('2099-03-10T00:00:00.000Z'),
      end: new Date('2099-03-11T00:00:00.000Z'),
    });
    await expect(
      checkBudget(testDb.db, { dailyCapUsd: '1.00', now: new Date('2099-03-10T18:00:00.000Z') }),
    ).resolves.toEqual({ dailySpentUsd: '0.45000000', runSpentUsd: undefined });
    await expect(
      checkBudget(testDb.db, { dailyCapUsd: '0.70', now: new Date('2099-03-09T00:00:00.000Z') }),
    ).rejects.toMatchObject({ kind: 'daily', spentUsd: '0.70000000' });
    // A new day starts from zero; a cap of 0 still blocks everything.
    await expect(
      checkBudget(testDb.db, { dailyCapUsd: '0.01', now: new Date('2099-03-11T00:00:00.000Z') }),
    ).resolves.toMatchObject({ dailySpentUsd: '0.00000000' });
    await expect(
      checkBudget(testDb.db, { dailyCapUsd: '0', now: new Date('2099-03-11T00:00:00.000Z') }),
    ).rejects.toMatchObject({ kind: 'daily', limitUsd: '0', spentUsd: '0.00000000' });
  });
});

describe('demo runs and the daily cap', () => {
  it('leaves replayed demo runs out of the daily total; other runs and run-less calls count', async () => {
    const day = new Date('2099-04-01T12:00:00.000Z');
    const demoOwner = await createUser(testDb.db, {
      email: DEMO_OWNER_EMAIL,
      passwordHash: 'not-a-login',
    });
    const demoRun = await seedRun(testDb.db, (await seedProject(testDb.db, demoOwner.id)).id);
    const { run: liveRun } = await seedRunWithParents(testDb.db);
    const insert = (runId: string | null, cost: string) =>
      testDb.db.insert(usageLedger).values({
        runId,
        modelId: 'fake-llm',
        estimatedCostUsd: cost,
        latencyMs: 1,
        createdAt: day,
      });
    await insert(demoRun.id, '0.90');
    await insert(liveRun.id, '0.03');
    await insert(null, '0.02');

    const { start, end } = utcDayWindow(day);
    // The ledger still holds everything (spend reports must filter demo usage themselves).
    expect(await getCostUsdSince(testDb.db, start, end)).toBe('0.95000000');
    expect(
      await getCostUsdSince(testDb.db, start, end, { excludeOwnerEmail: DEMO_OWNER_EMAIL }),
    ).toBe('0.05000000');
    // The demo's 0.90 does not use up a 0.10 live budget, and the live 0.05 still counts.
    await expect(checkBudget(testDb.db, { dailyCapUsd: '0.10', now: day })).resolves.toMatchObject({
      dailySpentUsd: '0.05000000',
    });
    await expect(checkBudget(testDb.db, { dailyCapUsd: '0.05', now: day })).rejects.toMatchObject({
      kind: 'daily',
      spentUsd: '0.05000000',
    });
    // The demo run's own cap is unaffected: it sees all of its spend.
    await expect(
      checkBudget(testDb.db, {
        dailyCapUsd: '9999',
        now: day,
        run: { runId: demoRun.id, capUsd: '0.50' },
      }),
    ).rejects.toMatchObject({ kind: 'run', spentUsd: '0.90000000' });
  });
});

describe('project deletion (ON DELETE SET NULL)', () => {
  it('drops the run reference but keeps the spend in the daily total', async () => {
    const { project, run } = await seedRunWithParents(testDb.db);
    const ledger = ledgerFor({ runId: run.id });
    ledger.record(entry());
    ledger.record(entry());
    const rows = await ledger.flush();
    const { start, end } = utcDayWindow(new Date());
    const dailyBefore = await getCostUsdSince(testDb.db, start, end);
    expect(await getRunCostUsd(testDb.db, run.id)).toBe('0.01000000');

    await deleteProject(testDb.db, project.id);

    const kept = await testDb.db
      .select({ runId: usageLedger.runId, cost: usageLedger.estimatedCostUsd })
      .from(usageLedger)
      .where(
        inArray(
          usageLedger.id,
          rows.map((r) => r.id),
        ),
      );
    expect(kept).toEqual([
      { runId: null, cost: '0.00500000' },
      { runId: null, cost: '0.00500000' },
    ]);
    expect(await getRunCostUsd(testDb.db, run.id)).toBe('0.00000000');
    expect(await getCostUsdSince(testDb.db, start, end)).toBe(dailyBefore);
  });
});

describe('recorded Spark call through the Meta clients', () => {
  // Same request as the P1-01 spark-text test, so it replays the recorded fixture.
  const replay = createMetaReplay({ cassette: 'p1-01/spark-text' });

  // Started after the container: replay blocks every non-Meta HTTP request, including the
  // Docker API calls Testcontainers makes.
  beforeAll(async () => {
    await replay.start();
  });

  afterAll(async () => {
    await replay.stop();
  });

  it('records units and the exact cost from the shared price table', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const ledger = createUsageLedger({
      db: testDb.db,
      runId: run.id,
      stepId: 'fact_extraction',
      dailyCapUsd: UNLIMITED_DAILY,
      runCapUsd: '0.50',
    });
    const clients = createMetaClients({
      apiKey: replay.apiKey,
      usage: ledger,
      estimateCost: createPriceTableCostEstimator(),
    });

    const result = await ledger.meter('muse-spark-1.3', () =>
      generateText({
        model: clients.languageModel('muse-spark-1.3'),
        prompt: 'In one short sentence, explain what a floor plan shows.',
        maxOutputTokens: 2048,
        ...clients.aiSdkCallOptions(),
      }),
    );
    replay.assertAllMatched();

    expect(result.text.trim()).not.toBe('');
    const rows = await testDb.db.select().from(usageLedger).where(eq(usageLedger.runId, run.id));
    expect(rows).toHaveLength(1);
    // Recorded usage: 20 input, 540 output (515 of them reasoning).
    // 20 × 0.00000125 + 540 × 0.00000425 = 0.00232
    expect(rows[0]).toMatchObject({
      modelId: 'muse-spark-1.3',
      stepId: 'fact_extraction',
      inputTokens: 20,
      outputTokens: 540,
      reasoningTokens: 515,
      estimatedCostUsd: '0.00232000',
    });
  });
});
