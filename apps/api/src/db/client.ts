import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.ts';

export type Database = NodePgDatabase<typeof schema>;

/**
 * The pool-backed database or an open transaction. Repository functions accept either, so
 * callers can compose several writes (and pg-boss enqueues) into one transaction.
 */
export type Executor = PgDatabase<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export interface DbClient {
  db: Database;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDbClient(databaseUrl: string): DbClient {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool, schema });

  return {
    db,
    async ping() {
      await db.execute(sql`select 1`);
    },
    async close() {
      await pool.end();
    },
  };
}
