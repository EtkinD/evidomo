import { and, asc, eq, gt } from 'drizzle-orm';
import type { Executor } from '../db/client.ts';
import { runEvents, runs } from '../db/schema.ts';
import type { RunEventSource } from './event-stream.ts';

/**
 * The event stream's two reads, each one short indexed query on the shared pool. Events are read
 * raw, not through `listRunEvents`: that repository parses type and payload, and a single row
 * the current schemas reject would then fail every reconnect at the same seq forever. The
 * columns' own types (int seq, text type, jsonb payload, timestamptz) are all the stream needs.
 */
export function createRunEventSource(db: Executor): RunEventSource {
  return {
    async head(runId) {
      const [row] = await db
        .select({ status: runs.status, lastEventSeq: runs.lastEventSeq })
        .from(runs)
        .where(eq(runs.id, runId));
      return row;
    },
    events: (runId, afterSeq, limit) =>
      db
        .select({
          seq: runEvents.seq,
          type: runEvents.type,
          payload: runEvents.payload,
          occurredAt: runEvents.occurredAt,
        })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
        .orderBy(asc(runEvents.seq))
        .limit(limit),
  };
}
