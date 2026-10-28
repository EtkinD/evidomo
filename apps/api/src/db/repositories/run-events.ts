import {
  runEventPayloadSchema,
  runEventTypeSchema,
  type RunEventPayload,
  type RunEventType,
} from '@evidomo/shared';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { NotFoundError } from '../errors.ts';
import { runEvents, runs } from '../schema.ts';
import { returnedRow } from './rows.ts';

export interface RunEvent {
  runId: string;
  /** Gapless, strictly increasing per run, starting at 1. */
  seq: number;
  type: RunEventType;
  payload: RunEventPayload;
  occurredAt: Date;
}

function toRunEvent(row: typeof runEvents.$inferSelect): RunEvent {
  return {
    ...row,
    type: runEventTypeSchema.parse(row.type),
    payload: runEventPayloadSchema.parse(row.payload),
  };
}

/**
 * Appends an event. The sequence number comes from incrementing runs.last_event_seq, which
 * row-locks the run until the transaction ends: concurrent appends to one run serialize and
 * commit in seq order, so readers never observe a gap that is filled later.
 */
export async function appendRunEvent(
  db: Executor,
  runId: string,
  event: { type: RunEventType; payload?: RunEventPayload },
): Promise<RunEvent> {
  const type = runEventTypeSchema.parse(event.type);
  const payload = runEventPayloadSchema.parse(event.payload ?? {});

  return db.transaction(async (tx) => {
    const [counter] = await tx
      .update(runs)
      .set({ lastEventSeq: sql`${runs.lastEventSeq} + 1` })
      .where(eq(runs.id, runId))
      .returning({ seq: runs.lastEventSeq });
    if (!counter) throw new NotFoundError('run', runId);

    const rows = await tx
      .insert(runEvents)
      .values({ runId, seq: counter.seq, type, payload })
      .returning();
    return toRunEvent(returnedRow(rows, 'run event'));
  });
}

/** Events in sequence order; `afterSeq` resumes a stream (e.g. from SSE Last-Event-ID). */
export async function listRunEvents(
  db: Executor,
  runId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<RunEvent[]> {
  const query = db
    .select()
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runId),
        options.afterSeq === undefined ? undefined : gt(runEvents.seq, options.afterSeq),
      ),
    )
    .orderBy(asc(runEvents.seq))
    .$dynamic();
  const rows = await (options.limit === undefined ? query : query.limit(options.limit));
  return rows.map(toRunEvent);
}
