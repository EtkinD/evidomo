import {
  jsonObjectSchema,
  officeProfileSchema,
  type JsonObject,
  type OfficeProfile,
} from '@evidomo/shared';
import type { ProjectStatus } from '@evidomo/shared';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
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
 * Ownership-checked lookup that row-locks the project until the transaction ends. Uploads,
 * material deletions, fact form saves, and run starts take it first, so the input lock (`inputsLocked`) and
 * the photo limit are checked and acted on atomically, and material and run timestamps follow
 * commit order.
 */
export async function lockProjectForOwner(
  db: Executor,
  projectId: string,
  ownerId: string,
): Promise<Project | undefined> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .for('update');
  return row && toProject(row);
}

/** Unscoped variant of {@link lockProjectForOwner} for callers that checked ownership already. */
export async function lockProject(db: Executor, projectId: string): Promise<Project | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).for('update');
  return row && toProject(row);
}

export interface ProjectChanges {
  title?: string;
  officeProfile?: OfficeProfile;
  factForm?: JsonObject;
  status?: ProjectStatus;
}

export async function updateProject(
  db: Executor,
  projectId: string,
  changes: ProjectChanges,
): Promise<Project> {
  const rows = await db
    .update(projects)
    .set({
      ...(changes.title === undefined ? {} : { title: changes.title }),
      ...(changes.officeProfile === undefined
        ? {}
        : { officeProfile: officeProfileSchema.parse(changes.officeProfile) }),
      ...(changes.factForm === undefined
        ? {}
        : { factForm: jsonObjectSchema.parse(changes.factForm) }),
      ...(changes.status === undefined ? {} : { status: changes.status }),
      updatedAt: sql`now()`,
    })
    .where(eq(projects.id, projectId))
    .returning();
  const [row] = rows;
  if (!row) throw new NotFoundError('project', projectId);
  return toProject(row);
}

export interface ProjectWithCounts {
  project: Project;
  photoCount: number;
  voiceMemoCount: number;
  latestRun: typeof runs.$inferSelect | undefined;
}

/** The owner's projects (newest first) with material counts and each project's latest run. */
export async function listProjectsWithCountsForOwner(
  db: Executor,
  ownerId: string,
): Promise<ProjectWithCounts[]> {
  // A join (not correlated subqueries) so Drizzle qualifies every column with its table.
  const rows = await db
    .select({
      project: projects,
      photoCount:
        sql<number>`count(${materials.id}) filter (where ${materials.kind} = 'photo')`.mapWith(
          Number,
        ),
      voiceMemoCount:
        sql<number>`count(${materials.id}) filter (where ${materials.kind} = 'voice_memo')`.mapWith(
          Number,
        ),
    })
    .from(projects)
    .leftJoin(materials, eq(materials.projectId, projects.id))
    .where(eq(projects.ownerId, ownerId))
    .groupBy(projects.id)
    .orderBy(desc(projects.createdAt), asc(projects.id));
  if (rows.length === 0) return [];
  const latest = await db
    .selectDistinctOn([runs.projectId])
    .from(runs)
    .where(
      inArray(
        runs.projectId,
        rows.map((row) => row.project.id),
      ),
    )
    .orderBy(runs.projectId, desc(runs.createdAt), desc(runs.id));
  const latestByProject = new Map(latest.map((run) => [run.projectId, run]));
  return rows.map((row) => ({
    project: toProject(row.project),
    photoCount: row.photoCount,
    voiceMemoCount: row.voiceMemoCount,
    latestRun: latestByProject.get(row.project.id),
  }));
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
