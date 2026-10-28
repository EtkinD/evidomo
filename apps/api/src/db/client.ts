import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import type { Logger } from '../logger.ts';
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

export interface DbClientOptions {
  /** Receives errors from idle pooled connections. */
  readonly logger: Pick<Logger, 'error'>;
}

function errorCode(error: Error): string | undefined {
  return 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export function createDbClient(databaseUrl: string, { logger }: DbClientOptions): DbClient {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // An idle pooled connection that dies (database restart, admin termination, network drop)
  // emits 'error' on the pool; with no listener Node treats it as unhandled and the process
  // crashes. pg has already discarded that connection and the next query opens a new one, so
  // logging is the whole handling. These are connection errors, not query errors, so they carry
  // no bound parameters; only the name, code, and message are logged.
  pool.on('error', (error) => {
    logger.error(
      { err: { name: error.name, code: errorCode(error), message: error.message } },
      'idle database connection error',
    );
  });
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
