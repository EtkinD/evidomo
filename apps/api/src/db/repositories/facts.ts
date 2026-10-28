import {
  factSourceSchema,
  jsonValueSchema,
  type FactSource,
  type FactStatus,
  type JsonValue,
} from '@evidomo/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { facts } from '../schema.ts';

type FactRow = typeof facts.$inferSelect;

export type Fact = Omit<FactRow, 'value' | 'sourceKind' | 'sourceRef'> & {
  value: JsonValue;
  source: FactSource;
};

export interface NewFact {
  stepId: string;
  key: string;
  value: JsonValue;
  unit?: string | null;
  basis?: string | null;
  source: FactSource;
  status?: FactStatus;
}

function toFact(row: FactRow): Fact {
  const { sourceKind, sourceRef, value, ...rest } = row;
  // source_ref holds the reference without its discriminant, which lives in source_kind.
  const ref = typeof sourceRef === 'object' && sourceRef !== null ? sourceRef : {};
  return {
    ...rest,
    value: jsonValueSchema.parse(value),
    source: factSourceSchema.parse({ ...ref, kind: sourceKind }),
  };
}

function toInsert(runId: string, fact: NewFact): typeof facts.$inferInsert {
  const { kind, ...ref } = factSourceSchema.parse(fact.source);
  return {
    runId,
    stepId: fact.stepId,
    key: fact.key,
    value: jsonValueSchema.parse(fact.value),
    unit: fact.unit ?? null,
    basis: fact.basis ?? null,
    sourceKind: kind,
    sourceRef: ref,
    ...(fact.status === undefined ? {} : { status: fact.status }),
  };
}

export async function insertFacts(
  db: Executor,
  runId: string,
  newFacts: readonly NewFact[],
): Promise<Fact[]> {
  if (newFacts.length === 0) return [];
  const rows = await db
    .insert(facts)
    .values(newFacts.map((fact) => toInsert(runId, fact)))
    .returning();
  return rows.map(toFact);
}

export async function listFacts(
  db: Executor,
  runId: string,
  filter: { status?: FactStatus; key?: string } = {},
): Promise<Fact[]> {
  const rows = await db
    .select()
    .from(facts)
    .where(
      and(
        eq(facts.runId, runId),
        filter.status === undefined ? undefined : eq(facts.status, filter.status),
        filter.key === undefined ? undefined : eq(facts.key, filter.key),
      ),
    )
    .orderBy(asc(facts.key), asc(facts.createdAt), asc(facts.id));
  return rows.map(toFact);
}

/** Sets the status of facts that belong to `runId`; returns how many were updated. */
export async function setFactStatus(
  db: Executor,
  runId: string,
  factIds: readonly string[],
  status: FactStatus,
): Promise<number> {
  if (factIds.length === 0) return 0;
  const updated = await db
    .update(facts)
    .set({ status, updatedAt: sql`now()` })
    .where(and(eq(facts.runId, runId), inArray(facts.id, [...factIds])))
    .returning({ id: facts.id });
  return updated.length;
}
