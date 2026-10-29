import {
  jsonObjectSchema,
  type JsonObject,
  type MaterialKind,
  type MaterialStatus,
} from '@evidomo/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
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
}

function toMaterial(row: MaterialRow): Material {
  return {
    ...row,
    metadata: row.metadata === null ? null : jsonObjectSchema.parse(row.metadata),
  };
}

export async function addMaterial(db: Executor, input: NewMaterial): Promise<Material> {
  const rows = await db.insert(materials).values(input).returning();
  return toMaterial(returnedRow(rows, 'material'));
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
