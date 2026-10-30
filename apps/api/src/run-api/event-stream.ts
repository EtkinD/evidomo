import {
  isRunStreamTerminal,
  RUN_STREAM_END_EVENT,
  RUN_STREAM_RESYNC_EVENT,
  runStreamEndSchema,
  runStreamResyncSchema,
  type RunStatus,
} from '@evidomo/shared';
import type { Response } from 'express';
import type { Logger } from '../logger.ts';
import { disclosedEvent, type RunCostVisibility } from './cost-visibility.ts';
import { createSseHub, namedSseEvent, type SseSession } from './sse.ts';

// The run monitor's event stream (docs/architecture.md §5 "Run API"): stored `run_events`
// after a cursor, then new ones as they commit, by a short poll on the run row and the events
// table. Each stream holds no database connection between polls (two indexed queries per tick
// through the shared pool); the SSE plumbing (heartbeat, poll timer, lifetime, per-user cap,
// cleanup on disconnect, end, lifetime, or shutdown) is `sse.ts`, shared with the demo replay.

/**
 * A stored event as the stream sends it: the row unchanged. Type and payload are deliberately
 * not parsed: one row the current schemas reject must not break the stream for good (the client
 * `safeParse`s and refetches the snapshot instead).
 */
export interface StreamedRunEvent {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
}

export interface RunEventSource {
  /** The run's status and newest committed event; undefined once the run is gone. */
  head(runId: string): Promise<{ status: RunStatus; lastEventSeq: number } | undefined>;
  /** Events with `seq > afterSeq` in order, at most `limit`. */
  events(runId: string, afterSeq: number, limit: number): Promise<readonly StreamedRunEvent[]>;
}

export interface RunEventStreamOptions {
  /** Poll interval while waiting for new events. Default 1000 ms. */
  readonly pollIntervalMs?: number;
  /** SSE comment interval, so idle proxies and browsers keep the connection. Default 15 s. */
  readonly heartbeatIntervalMs?: number;
  /** Events read per query while catching up. Default 200. */
  readonly batchSize?: number;
  /** Reconnect delay the browser uses after a dropped stream (`retry:`). Default 3000 ms. */
  readonly retryMs?: number;
  /**
   * A stream is closed (without `end`) after this long, so the browser reconnects and the
   * session and ownership are checked again. Default 1 hour.
   */
  readonly maxLifetimeMs?: number;
  /** Open streams per user; one more is refused with 429 `too_many_streams`. Default 5. */
  readonly maxStreamsPerUser?: number;
}

export interface RunEventStreamsDeps {
  readonly source: RunEventSource;
  readonly logger: Logger;
  /** `hidden`: no cost values and no `usage_recorded` (sent as `withheld`), see `disclosedEvent`. */
  readonly costs: RunCostVisibility;
  readonly options?: RunEventStreamOptions;
  /** Aborted on shutdown: every open stream ends so `server.close()` can finish. */
  readonly shutdownSignal?: AbortSignal;
}

export interface ServeRunEvents {
  readonly runId: string;
  /** Counts against `maxStreamsPerUser`. */
  readonly userId: string;
  /** The validated cursor (`Last-Event-ID` or `?after=`). */
  readonly afterSeq: number;
}

export interface RunEventStreams {
  /**
   * Serves one stream on `res` until the run ends, the client disconnects, the lifetime is up,
   * or shutdown. The caller has checked ownership. Answers 429 instead when the user has too
   * many open streams. Resolves once every timer is cleared and no query is in flight.
   */
  serve(res: Response, request: ServeRunEvents): Promise<void>;
  /** Streams currently open (for tests and diagnostics). */
  activeCount(): number;
}

/** One SSE message for a stored event: `id` = seq, default event type, JSON data. */
export function formatRunEvent(event: StreamedRunEvent): string {
  const data = JSON.stringify({
    seq: event.seq,
    type: event.type,
    payload: event.payload,
    occurredAt: event.occurredAt.toISOString(),
  });
  return `id: ${event.seq}\ndata: ${data}\n\n`;
}

export function createRunEventStreams(deps: RunEventStreamsDeps): RunEventStreams {
  const pollIntervalMs = deps.options?.pollIntervalMs ?? 1000;
  const batchSize = deps.options?.batchSize ?? 200;
  const { source } = deps;
  const hub = createSseHub({
    logger: deps.logger,
    limits: {
      heartbeatIntervalMs: deps.options?.heartbeatIntervalMs ?? 15_000,
      retryMs: deps.options?.retryMs ?? 3000,
      maxLifetimeMs: deps.options?.maxLifetimeMs ?? 60 * 60 * 1000,
      maxStreamsPerKey: deps.options?.maxStreamsPerUser ?? 5,
      // `no-transform` stops Caddy's `encode` from compressing (and buffering) the stream.
      cacheControl: 'private, no-cache, no-transform',
    },
    ...(deps.shutdownSignal === undefined ? {} : { shutdownSignal: deps.shutdownSignal }),
    failureMessage: 'run event stream failed',
  });

  async function follow(session: SseSession, runId: string, afterSeq: number): Promise<void> {
    let cursor = afterSeq;
    while (!session.isClosed()) {
      const head = await source.head(runId);
      if (session.isClosed() || head === undefined) return; // gone: the project was deleted.
      if (cursor > head.lastEventSeq) {
        // A cursor this run never reached (another run's ID, a hand-made `after`): continue from
        // the run's real head and tell the client to refetch the snapshot, rather than wait
        // for events up to the bogus seq and skip everything before it.
        cursor = head.lastEventSeq;
        await session.write(
          namedSseEvent(
            RUN_STREAM_RESYNC_EVENT,
            runStreamResyncSchema.parse({ lastEventSeq: head.lastEventSeq }),
          ),
        );
      }
      // Events up to the head's seq are committed (the counter and the row commit together),
      // and seq is gapless per run, so reading up to it never skips a later-committing event.
      while (!session.isClosed() && cursor < head.lastEventSeq) {
        const batch = await source.events(runId, cursor, batchSize);
        if (session.isClosed()) return;
        const due = batch.filter((event) => event.seq > cursor && event.seq <= head.lastEventSeq);
        if (due.length === 0) break;
        for (const event of due) {
          await session.write(formatRunEvent(disclosedEvent(event, deps.costs)));
          cursor = event.seq;
        }
      }
      if (session.isClosed()) return;
      if (isRunStreamTerminal(head.status) && cursor >= head.lastEventSeq) {
        const end = runStreamEndSchema.parse({
          status: head.status,
          lastEventSeq: head.lastEventSeq,
        });
        await session.write(namedSseEvent(RUN_STREAM_END_EVENT, end));
        return;
      }
      await session.sleep(pollIntervalMs);
    }
  }

  return {
    serve: (res, { runId, userId, afterSeq }) =>
      hub.serve(res, userId, (session) => follow(session, runId, afterSeq), { runId }),
    activeCount: () => hub.activeCount(),
  };
}
