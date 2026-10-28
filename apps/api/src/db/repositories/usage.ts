import { usdAmountSchema } from '@evidomo/shared';
import { and, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../client.ts';
import { usageLedger } from '../schema.ts';
import { returnedRow } from './rows.ts';

export type UsageEntry = typeof usageLedger.$inferSelect;

const unitCount = z.int().nonnegative().max(2_147_483_647);

// Validated before insert because numeric columns silently round extra fraction digits.
const newUsageSchema = z.object({
  runId: z.uuid().nullable().default(null),
  stepId: z.string().min(1).nullable().default(null),
  modelId: z.string().min(1),
  inputTokens: unitCount.default(0),
  outputTokens: unitCount.default(0),
  reasoningTokens: unitCount.default(0),
  audioSeconds: z
    .string()
    .regex(/^\d{1,7}(\.\d{1,3})?$/, 'Expected seconds with at most 3 fraction digits')
    .default('0'),
  images: unitCount.default(0),
  estimatedCostUsd: usdAmountSchema,
  latencyMs: unitCount,
});

export type NewUsage = z.input<typeof newUsageSchema>;

/** Records one model call. `runId` is omitted for calls outside a run. */
export async function recordUsage(db: Executor, input: NewUsage): Promise<UsageEntry> {
  const rows = await db.insert(usageLedger).values(newUsageSchema.parse(input)).returning();
  return returnedRow(rows, 'usage');
}

export async function listUsageForRun(db: Executor, runId: string): Promise<UsageEntry[]> {
  return db
    .select()
    .from(usageLedger)
    .where(eq(usageLedger.runId, runId))
    .orderBy(usageLedger.createdAt, usageLedger.id);
}

async function sumCost(db: Executor, where: SQL | undefined): Promise<string> {
  // Summed and formatted in PostgreSQL: exact decimal arithmetic, never JS floats.
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${usageLedger.estimatedCostUsd}), 0)::numeric(20, 8)::text`,
    })
    .from(usageLedger)
    .where(where);
  return row?.total ?? '0.00000000';
}

/** Total estimated cost of a run, as an exact decimal string with 8 fraction digits. */
export async function getRunCostUsd(db: Executor, runId: string): Promise<string> {
  return sumCost(db, eq(usageLedger.runId, runId));
}

/**
 * Total estimated cost of all calls recorded at or after `since` and, when given, before
 * `until` (exclusive), e.g. one UTC day for the global daily cap.
 */
export async function getCostUsdSince(db: Executor, since: Date, until?: Date): Promise<string> {
  const from = gte(usageLedger.createdAt, since);
  return sumCost(db, until === undefined ? from : and(from, lt(usageLedger.createdAt, until)));
}
