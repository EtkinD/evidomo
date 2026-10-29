import {
  isRunStreamTerminal,
  RUN_STREAM_END_EVENT,
  RUN_STREAM_RESYNC_EVENT,
  runStreamEndSchema,
  runStreamResyncSchema,
  type RunStatus,
} from '@evidomo/shared';
import type { Response } from 'express';
import { errorForLog, sendError } from '../http/errors.ts';
import type { Logger } from '../logger.ts';

// The run monitor's event stream (docs/architecture.md §5 "Run API"): stored `run_events`
// after a cursor, then new ones as they commit, by a short poll on the run row and the events
// table. Each stream holds no database connection between polls (two indexed queries per tick
// through the shared pool) and owns one heartbeat interval, one poll timer, and one lifetime
// timer, all cleared when the client goes away, the run ends, the lifetime is up, or the server
// shuts down.

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

function namedEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createRunEventStreams(deps: RunEventStreamsDeps): RunEventStreams {
  const pollIntervalMs = deps.options?.pollIntervalMs ?? 1000;
  const heartbeatIntervalMs = deps.options?.heartbeatIntervalMs ?? 15_000;
  const batchSize = deps.options?.batchSize ?? 200;
  const retryMs = deps.options?.retryMs ?? 3000;
  const maxLifetimeMs = deps.options?.maxLifetimeMs ?? 60 * 60 * 1000;
  const maxStreamsPerUser = deps.options?.maxStreamsPerUser ?? 5;
  const { source, logger, shutdownSignal } = deps;
  const perUser = new Map<string, number>();
  // A function, not an inline check: TypeScript would keep the earlier check's narrowing.
  const shuttingDown = (): boolean => shutdownSignal?.aborted === true;
  let active = 0;

  async function serve(res: Response, { runId, userId, afterSeq }: ServeRunEvents): Promise<void> {
    let closed = false;
    let wake: (() => void) | undefined;
    const close = (): void => {
      closed = true;
      wake?.();
    };
    res.on('close', close);
    shutdownSignal?.addEventListener('abort', close, { once: true });
    // The client may have gone while the caller awaited the ownership check: 'close' was then
    // emitted before the listener existed.
    if (res.destroyed || res.writableEnded || shuttingDown()) {
      res.off('close', close);
      shutdownSignal?.removeEventListener('abort', close);
      return;
    }

    const open = perUser.get(userId) ?? 0;
    if (open >= maxStreamsPerUser) {
      res.off('close', close);
      shutdownSignal?.removeEventListener('abort', close);
      res.set('Cache-Control', 'no-store');
      sendError(res, 429, 'too_many_streams');
      return;
    }
    perUser.set(userId, open + 1);
    active += 1;

    let pollTimer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const lifetime = setTimeout(close, maxLifetimeMs);

    /** Waits for `drain` (or the end of the stream) when the socket buffer is full. */
    async function write(chunk: string): Promise<void> {
      if (closed) return;
      if (res.write(chunk)) return;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done);
          res.off('close', done);
          wake = undefined;
          resolve();
        };
        wake = done;
        res.on('drain', done);
        res.on('close', done);
      });
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(pollTimer);
          pollTimer = undefined;
          wake = undefined;
          resolve();
        };
        wake = done;
        pollTimer = setTimeout(done, ms);
      });
    }

    try {
      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        // `no-transform` stops Caddy's `encode` from compressing (and buffering) the stream.
        'Cache-Control': 'private, no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      heartbeat = setInterval(() => {
        // A comment line: ignored by EventSource, keeps proxies from timing the stream out.
        // Skipped while the buffer is full, so a stalled client cannot grow it.
        if (!closed && res.writableNeedDrain !== true) res.write(': ping\n\n');
      }, heartbeatIntervalMs);
      await write(`retry: ${retryMs}\n\n`);

      let cursor = afterSeq;
      while (!closed) {
        const head = await source.head(runId);
        if (closed || head === undefined) break; // gone: the project was deleted mid-stream.
        if (cursor > head.lastEventSeq) {
          // A cursor this run never reached (another run's ID, a hand-made `after`): continue from
          // the run's real head and tell the client to refetch the snapshot, rather than wait
          // for events up to the bogus seq and skip everything before it.
          cursor = head.lastEventSeq;
          await write(
            namedEvent(
              RUN_STREAM_RESYNC_EVENT,
              runStreamResyncSchema.parse({ lastEventSeq: head.lastEventSeq }),
            ),
          );
        }
        // Events up to the head's seq are committed (the counter and the row commit together),
        // and seq is gapless per run, so reading up to it never skips a later-committing event.
        while (!closed && cursor < head.lastEventSeq) {
          const batch = await source.events(runId, cursor, batchSize);
          if (closed) break;
          const due = batch.filter((event) => event.seq > cursor && event.seq <= head.lastEventSeq);
          if (due.length === 0) break;
          for (const event of due) {
            await write(formatRunEvent(event));
            cursor = event.seq;
          }
        }
        if (closed) break;
        if (isRunStreamTerminal(head.status) && cursor >= head.lastEventSeq) {
          const end = runStreamEndSchema.parse({
            status: head.status,
            lastEventSeq: head.lastEventSeq,
          });
          await write(namedEvent(RUN_STREAM_END_EVENT, end));
          break;
        }
        await sleep(pollIntervalMs);
      }
    } catch (error) {
      // Headers are sent: end the stream; the browser reconnects with Last-Event-ID.
      logger.error({ err: errorForLog(error), runId }, 'run event stream failed');
    } finally {
      clearInterval(heartbeat);
      clearTimeout(pollTimer);
      clearTimeout(lifetime);
      res.off('close', close);
      shutdownSignal?.removeEventListener('abort', close);
      if (!res.writableEnded && !res.destroyed) {
        if (shuttingDown()) {
          // A keep-alive socket would hold `server.close()` open until its idle timeout.
          const socket = res.socket;
          res.end(() => socket?.end());
        } else {
          res.end();
        }
      }
      const remaining = (perUser.get(userId) ?? 1) - 1;
      if (remaining <= 0) perUser.delete(userId);
      else perUser.set(userId, remaining);
      active -= 1;
    }
  }

  return { serve, activeCount: () => active };
}
