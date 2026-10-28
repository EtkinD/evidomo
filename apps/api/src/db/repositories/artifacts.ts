import { jsonValueSchema, type JsonValue } from '@evidomo/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../client.ts';
import { artifacts } from '../schema.ts';
import { returnedRow } from './rows.ts';

type ArtifactRow = typeof artifacts.$inferSelect;

export type Artifact = Omit<ArtifactRow, 'content'> & { content: JsonValue | null };

// Artifact kinds are defined by the pipeline steps (an open set); only the shape is enforced.
const artifactKindSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'Expected a snake_case kind');

/** An artifact is structured content, a stored file, or both. */
export type NewArtifact = {
  runId: string;
  stepId: string;
  kind: string;
  /** usage_ledger IDs of the model calls that produced it. */
  usageIds?: readonly string[];
} & (
  | { content: JsonValue; file?: { storageKey: string; mimeType: string } }
  | { content?: undefined; file: { storageKey: string; mimeType: string } }
);

function toArtifact(row: ArtifactRow): Artifact {
  return {
    ...row,
    content: row.content === null ? null : jsonValueSchema.parse(row.content),
  };
}

export async function insertArtifact(db: Executor, input: NewArtifact): Promise<Artifact> {
  const rows = await db
    .insert(artifacts)
    .values({
      runId: input.runId,
      stepId: input.stepId,
      kind: artifactKindSchema.parse(input.kind),
      content: input.content === undefined ? null : jsonValueSchema.parse(input.content),
      storageKey: input.file?.storageKey ?? null,
      mimeType: input.file?.mimeType ?? null,
      usageIds: [...(input.usageIds ?? [])],
    })
    .returning();
  return toArtifact(returnedRow(rows, 'artifact'));
}

/**
 * Kinds covered by the `artifacts_singleton_kind_key` partial unique index: at most one per run,
 * step, and kind. Keep in sync with the index predicate in `schema.ts`.
 */
export const SINGLETON_ARTIFACT_KINDS = ['transcript', 'fact_extraction'] as const;
export type SingletonArtifactKind = (typeof SINGLETON_ARTIFACT_KINDS)[number];

/**
 * Inserts a singleton-kind artifact unless the run's step already has one of that kind, in
 * which case the existing artifact is returned unchanged (`created: false`). The first stored
 * version stays authoritative because later rows (facts) cite it by ID.
 */
export async function insertSingletonArtifact(
  db: Executor,
  input: NewArtifact & { kind: SingletonArtifactKind },
): Promise<{ artifact: Artifact; created: boolean }> {
  const rows = await db
    .insert(artifacts)
    .values({
      runId: input.runId,
      stepId: input.stepId,
      kind: input.kind,
      content: input.content === undefined ? null : jsonValueSchema.parse(input.content),
      storageKey: input.file?.storageKey ?? null,
      mimeType: input.file?.mimeType ?? null,
      usageIds: [...(input.usageIds ?? [])],
    })
    .onConflictDoNothing({
      target: [artifacts.runId, artifacts.stepId, artifacts.kind],
      // Must match the index predicate for Postgres to infer the partial index.
      where: sql`${artifacts.kind} in ('transcript', 'fact_extraction')`,
    })
    .returning();
  const [inserted] = rows;
  if (inserted !== undefined) return { artifact: toArtifact(inserted), created: true };
  const [existing] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.runId, input.runId),
        eq(artifacts.stepId, input.stepId),
        eq(artifacts.kind, input.kind),
      ),
    );
  if (existing === undefined) {
    throw new Error(`Singleton artifact ${input.kind} conflicted but could not be read`);
  }
  return { artifact: toArtifact(existing), created: false };
}

export async function getArtifact(db: Executor, artifactId: string): Promise<Artifact | undefined> {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId));
  return row && toArtifact(row);
}

export async function listArtifacts(
  db: Executor,
  runId: string,
  filter: { kind?: string; stepId?: string } = {},
): Promise<Artifact[]> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.runId, runId),
        filter.kind === undefined ? undefined : eq(artifacts.kind, filter.kind),
        filter.stepId === undefined ? undefined : eq(artifacts.stepId, filter.stepId),
      ),
    )
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id));
  return rows.map(toArtifact);
}
