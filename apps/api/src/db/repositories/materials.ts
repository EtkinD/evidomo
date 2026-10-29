import {
  jsonObjectSchema,
  type JsonObject,
  type MaterialKind,
  type MaterialStatus,
} from '@evidomo/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { NotFoundError } from '../errors.ts';
import { materials } from '../schema.ts';
import { returnedRow } from './rows.ts';

type MaterialRow = typeof materials.$inferSelect;

export type Material = Omit<MaterialRow, 'metadata'> & { metadata: JsonObject | null };

export interface NewMaterial {
  projectId: string;
  kind: MaterialKind;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  /** Lower-case hex SHA-256 of the stored file. */
  sha256: string;
  status?: MaterialStatus;
  /** Processing metadata (`packages/shared/src/materials.ts` shapes), e.g. for a `ready` row. */
  metadata?: JsonObject;
}

function toMaterial(row: MaterialRow): Material {
  return {
    ...row,
    metadata: row.metadata === null ? null : jsonObjectSchema.parse(row.metadata),
  };
}

/**
 * `created_at` is the wall clock at insert (`clock_timestamp()`), not the transaction start
 * (`now()`): upload order is material order, and callers that insert under the project lock
 * (uploads, run start) then get timestamps in commit order, so a run created after an upload
 * always sorts after it (docs/architecture.md §8).
 */
export async function addMaterial(db: Executor, input: NewMaterial): Promise<Material> {
  const { metadata, ...row } = input;
  const rows = await db
    .insert(materials)
    .values({
      ...row,
      ...(metadata === undefined ? {} : { metadata: jsonObjectSchema.parse(metadata) }),
      createdAt: sql`clock_timestamp()`,
    })
    .returning();
  return toMaterial(returnedRow(rows, 'material'));
}

/** The material stored under `storageKey`, if its row exists (keys are unique). */
export async function getMaterialByStorageKey(
  db: Executor,
  storageKey: string,
): Promise<Material | undefined> {
  const [row] = await db.select().from(materials).where(eq(materials.storageKey, storageKey));
  return row && toMaterial(row);
}

/** Deletes one material of a project; returns its storage key, or undefined when none matched. */
export async function deleteProjectMaterial(
  db: Executor,
  projectId: string,
  materialId: string,
): Promise<{ storageKey: string } | undefined> {
  const [row] = await db
    .delete(materials)
    .where(and(eq(materials.id, materialId), eq(materials.projectId, projectId)))
    .returning({ storageKey: materials.storageKey });
  return row;
}

/** Deletes the given materials of a project; returns the storage keys of the deleted rows. */
export async function deleteProjectMaterials(
  db: Executor,
  projectId: string,
  materialIds: readonly string[],
): Promise<string[]> {
  if (materialIds.length === 0) return [];
  const rows = await db
    .delete(materials)
    .where(and(eq(materials.projectId, projectId), inArray(materials.id, [...materialIds])))
    .returning({ storageKey: materials.storageKey });
  return rows.map((row) => row.storageKey);
}

export async function listMaterials(
  db: Executor,
  projectId: string,
  filter: { kind?: MaterialKind } = {},
): Promise<Material[]> {
  const rows = await db
    .select()
    .from(materials)
    .where(
      and(
        eq(materials.projectId, projectId),
        filter.kind === undefined ? undefined : eq(materials.kind, filter.kind),
      ),
    )
    .orderBy(asc(materials.createdAt), asc(materials.id));
  return rows.map(toMaterial);
}

/** Updates processing status; metadata is replaced only when provided. */
export async function setMaterialStatus(
  db: Executor,
  materialId: string,
  status: MaterialStatus,
  metadata?: JsonObject,
): Promise<Material> {
  const rows = await db
    .update(materials)
    .set({
      status,
      ...(metadata === undefined ? {} : { metadata: jsonObjectSchema.parse(metadata) }),
      updatedAt: sql`now()`,
    })
    .where(eq(materials.id, materialId))
    .returning();
  const [row] = rows;
  if (!row) throw new NotFoundError('material', materialId);
  return toMaterial(row);
}

/** The material if it belongs to `projectId`; undefined for another project's ID. */
export async function getProjectMaterial(
  db: Executor,
  projectId: string,
  materialId: string,
): Promise<Material | undefined> {
  const [row] = await db
    .select()
    .from(materials)
    .where(and(eq(materials.projectId, projectId), eq(materials.id, materialId)));
  return row && toMaterial(row);
}
