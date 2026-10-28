import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedRunWithParents, startTestDatabase, type TestDatabase } from '../testing.ts';
import { getCostUsdSince, getRunCostUsd, listUsageForRun, recordUsage } from './usage.ts';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb.stop();
});

describe('usage ledger repository', () => {
  it('records one row per model call with all unit kinds', async () => {
    const { run } = await seedRunWithParents(testDb.db);

    const entry = await recordUsage(testDb.db, {
      runId: run.id,
      stepId: 'reconciliation',
      modelId: 'muse-wonder-1.0',
      inputTokens: 12_000,
      outputTokens: 1_500,
      reasoningTokens: 900,
      estimatedCostUsd: '0.078',
      latencyMs: 8_400,
    });
    const audio = await recordUsage(testDb.db, {
      runId: run.id,
      stepId: 'intake',
      modelId: 'muse-voice-transcribe-1.0',
      audioSeconds: '183.250',
      estimatedCostUsd: '0.0091625',
      latencyMs: 2_100,
    });

    expect(entry).toMatchObject({
      inputTokens: 12_000,
      outputTokens: 1_500,
      reasoningTokens: 900,
      audioSeconds: '0.000',
      images: 0,
      estimatedCostUsd: '0.07800000',
    });
    expect(audio.audioSeconds).toBe('183.250');
    expect((await listUsageForRun(testDb.db, run.id)).map((u) => u.id)).toEqual([
      entry.id,
      audio.id,
    ]);
  });

  it('sums costs with exact decimal arithmetic', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    for (const cost of ['0.1', '0.2', '0.00000125']) {
      await recordUsage(testDb.db, {
        runId: run.id,
        modelId: 'muse-spark-1.3',
        estimatedCostUsd: cost,
        latencyMs: 100,
      });
    }

    // 0.1 + 0.2 in binary floating point would be 0.30000000000000004.
    expect(await getRunCostUsd(testDb.db, run.id)).toBe('0.30000125');
    const empty = await seedRunWithParents(testDb.db);
    expect(await getRunCostUsd(testDb.db, empty.run.id)).toBe('0.00000000');
  });

  it('records calls outside a run and includes them in the time-window total', async () => {
    // A millisecond-aligned window start (JS Dates have ms precision) strictly after every
    // earlier row, followed by a short sleep so this call lands inside the window.
    const { rows } = await testDb.db.execute<{ start: string }>(
      sql`select to_json(date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond')#>>'{}' as start, pg_sleep(0.005)`,
    );
    const windowStart = new Date(rows[0]?.start ?? Number.NaN);
    expect(Number.isNaN(windowStart.getTime())).toBe(false);

    const entry = await recordUsage(testDb.db, {
      modelId: 'sam-3.1',
      images: 4,
      estimatedCostUsd: '0.01',
      latencyMs: 1_200,
    });

    expect(entry.runId).toBeNull();
    expect(entry.images).toBe(4);
    expect(await getCostUsdSince(testDb.db, windowStart)).toBe('0.01000000');
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(await getCostUsdSince(testDb.db, future)).toBe('0.00000000');
  });

  it('rejects amounts the numeric column would silently round, and negative units', async () => {
    await expect(
      recordUsage(testDb.db, {
        modelId: 'muse-spark-1.3',
        estimatedCostUsd: '0.000000001',
        latencyMs: 1,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      recordUsage(testDb.db, {
        modelId: 'muse-spark-1.3',
        inputTokens: -1,
        estimatedCostUsd: '0',
        latencyMs: 1,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });
});
