import { jsonValueSchema, type JsonValue } from '@evidomo/shared';
import { and, asc, eq } from 'drizzle-orm';
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
