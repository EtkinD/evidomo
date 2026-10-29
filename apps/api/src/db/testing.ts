// Integration-test support: a migrated PostgreSQL in a Testcontainers container, plus
// builders for the parent rows most repository tests need. Imported only by
// *.integration.test.ts files and by the headless pipeline CLI (`src/cli/`, which runs each
// project on a throwaway database); never by the server or worker.
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createLogger } from '../logger.ts';
import { createDbClient, type Database, type DbClient } from './client.ts';
import { createProject, type NewProject, type Project } from './repositories/projects.ts';
import { createRun, type NewRun, type Run } from './repositories/runs.ts';
import { createUser, type PublicUser } from './repositories/users.ts';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface TestDatabase {
  client: DbClient;
  db: Database;
  container: StartedPostgreSqlContainer;
  stop(): Promise<void>;
}

/** Starts PostgreSQL and applies every migration, exactly as `db:migrate` does. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  // The test logger is disabled; idle-connection errors during container teardown are expected.
  const client = createDbClient(container.getConnectionUri(), {
    logger: createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' }),
  });
  try {
    await migrate(client.db, { migrationsFolder });
  } catch (error) {
    await client.close();
    await container.stop();
    throw error;
  }
  return {
    client,
    db: client.db,
    container,
    async stop() {
      await client.close();
      await container.stop();
    },
  };
}

let sequence = 0;
function nextId(): number {
  sequence += 1;
  return sequence;
}

export async function seedUser(db: Database): Promise<PublicUser> {
  return createUser(db, {
    email: `operator-${nextId()}@example.test`,
    passwordHash: 'not-a-real-hash',
  });
}

export async function seedProject(
  db: Database,
  ownerId: string,
  overrides: Partial<NewProject> = {},
): Promise<Project> {
  return createProject(db, {
    ownerId,
    title: `Test listing ${nextId()}`,
    officeProfile: { agencyName: 'Example Makelaardij', tone: 'warm' },
    marketProfileId: 'nl',
    marketProfileVersion: 1,
    outputLanguage: 'en',
    ...overrides,
  });
}

export async function seedRun(
  db: Database,
  projectId: string,
  overrides: Partial<NewRun> = {},
): Promise<Run> {
  return createRun(db, {
    projectId,
    serviceId: 'listing-launch',
    serviceVersion: 1,
    marketProfileId: 'nl',
    marketProfileVersion: 1,
    outputLanguage: 'en',
    ...overrides,
  });
}

/** A user, a project, and a queued run in one call. */
export async function seedRunWithParents(
  db: Database,
): Promise<{ user: PublicUser; project: Project; run: Run }> {
  const user = await seedUser(db);
  const project = await seedProject(db, user.id);
  const run = await seedRun(db, project.id);
  return { user, project, run };
}
