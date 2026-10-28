import {
  jsonObjectSchema,
  officeProfileSchema,
  type JsonObject,
  type OfficeProfile,
} from '@evidomo/shared';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { NotFoundError } from '../errors.ts';
import { artifacts, materials, projects, runs } from '../schema.ts';
import { returnedRow } from './rows.ts';

type ProjectRow = typeof projects.$inferSelect;

export type Project = Omit<ProjectRow, 'officeProfile' | 'factForm'> & {
  officeProfile: OfficeProfile;
  factForm: JsonObject;
};

export interface NewProject {
  ownerId: string;
  title: string;
  officeProfile: OfficeProfile;
  marketProfileId: string;
  marketProfileVersion: number;
  outputLanguage: string;
  factForm?: JsonObject;
}

function toProject(row: ProjectRow): Project {
  return {
    ...row,
    officeProfile: officeProfileSchema.parse(row.officeProfile),
    factForm: jsonObjectSchema.parse(row.factForm),
  };
}

export async function createProject(db: Executor, input: NewProject): Promise<Project> {
  const rows = await db
    .insert(projects)
    .values({
      ...input,
      officeProfile: officeProfileSchema.parse(input.officeProfile),
      factForm: jsonObjectSchema.parse(input.factForm ?? {}),
    })
    .returning();
  return toProject(returnedRow(rows, 'project'));
}

/** Unscoped lookup for internal callers (worker). HTTP routes use getProjectForOwner. */
export async function getProject(db: Executor, projectId: string): Promise<Project | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  return row && toProject(row);
}

/** Ownership-checked lookup: undefined both when missing and when owned by someone else. */
export async function getProjectForOwner(
  db: Executor,
  projectId: string,
  ownerId: string,
): Promise<Project | undefined> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
  return row && toProject(row);
}

export async function listProjectsForOwner(db: Executor, ownerId: string): Promise<Project[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.ownerId, ownerId))
    .orderBy(desc(projects.createdAt), asc(projects.id));
  return rows.map(toProject);
}

/**
 * Hard-deletes a project and, through FK cascades, every derived row. Returns the storage
 * keys of the project's files so the caller can remove them after the transaction commits.
 */
export async function deleteProject(
  db: Executor,
  projectId: string,
): Promise<{ storageKeys: string[] }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    if (!locked) throw new NotFoundError('project', projectId);

    const materialKeys = await tx
      .select({ storageKey: materials.storageKey })
      .from(materials)
      .where(eq(materials.projectId, projectId));
    const artifactKeys = await tx
      .select({ storageKey: artifacts.storageKey })
      .from(artifacts)
      .where(
        and(
          isNotNull(artifacts.storageKey),
          inArray(
            artifacts.runId,
            tx.select({ id: runs.id }).from(runs).where(eq(runs.projectId, projectId)),
          ),
        ),
      );

    await tx.delete(projects).where(eq(projects.id, projectId));

    return {
      storageKeys: [
        ...materialKeys.map((m) => m.storageKey),
        ...artifactKeys.flatMap((a) => (a.storageKey === null ? [] : [a.storageKey])),
      ],
    };
  });
}
