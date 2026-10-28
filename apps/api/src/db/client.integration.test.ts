import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbClient } from './client.ts';
import { startTestDatabase, type TestDatabase } from './testing.ts';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('createDbClient', () => {
  it('logs an idle connection that the server terminates, and keeps working', async () => {
    const applicationName = 'evidomo-idle-error-test';
    const url = new URL(testDb.container.getConnectionUri());
    url.searchParams.set('application_name', applicationName);

    const logged: { obj: unknown; msg: string | undefined }[] = [];
    const client = createDbClient(url.toString(), {
      logger: {
        error: (obj: unknown, msg?: string) => {
          logged.push({ obj, msg });
        },
      },
    });

    try {
      // Opens a connection and returns it to the pool, where it sits idle.
      await client.ping();

      // Terminating it from another session makes the idle client emit 'error' on the pool.
      // Without a listener that is an unhandled 'error' event and crashes the process (and this
      // test run).
      const terminated = await testDb.db.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${applicationName}`,
      );
      expect(terminated.rows).toHaveLength(1);

      await waitFor(() => logged.length > 0);
      expect(logged[0]?.msg).toBe('idle database connection error');
      // admin_shutdown: the server terminated the connection.
      expect(logged[0]?.obj).toMatchObject({ err: { code: '57P01' } });

      // pg discarded the dead connection; the next query gets a fresh one.
      await expect(client.ping()).resolves.toBeUndefined();
    } finally {
      await client.close();
    }
  });
});
