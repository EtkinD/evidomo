import {
  isRunStreamTerminal,
  RUN_STREAM_END_EVENT,
  RUN_STREAM_RESYNC_EVENT,
  runStreamEndSchema,
  runStreamResyncSchema,
} from '@evidomo/shared';
import type { Response } from 'express';
import type { Logger } from '../logger.ts';
import { disclosedEvent, type RunCostVisibility } from '../run-api/cost-visibility.ts';
import { formatRunEvent, type RunEventSource } from '../run-api/event-stream.ts';
import { createSseHub, namedSseEvent, type SseSession } from '../run-api/sse.ts';

// The demo replay stream (docs/architecture.md §5 "Demo API", §11): a completed run's stored
// `run_events` re-emitted with their original spacing, as the same SSE messages the live monitor
// receives (`id` = seq, `runStreamEventSchema` data, `resync`, `end`), so the web client can be
// reused. Reads only (the raw event source the live stream uses); nothing is written and no
// model is called. Long gaps (a gate wait of hours) are capped, and `?speed=` scales the result.

/** Longest pause between two replayed events at speed 1. */
export const DEFAULT_REPLAY_MAX_GAP_MS = 3000;

export interface ReplayTiming {
  /** Each original gap is capped at this before the speed applies. */
  readonly maxGapMs: number;
  /** Multiplier: 2 replays twice as fast. */
  readonly speed: number;
}

/**
 * The pause before `next`: its original distance from `previous` (0 for the first event, and for
 * clocks that went backwards), capped at `maxGapMs`, divided by `speed`, in whole milliseconds.
 */
export function replayDelayMs(
  previous: Date | undefined,
  next: Date,
  { maxGapMs, speed }: ReplayTiming,
): number {
  if (previous === undefined) return 0;
  const gap = Math.max(0, next.getTime() - previous.getTime());
  return Math.round(Math.min(gap, maxGapMs) / speed);
}

export interface DemoReplayOptions {
  /** Default `DEFAULT_REPLAY_MAX_GAP_MS`. */
  readonly maxGapMs?: number;
  /** Events read per query. Default 200. */
  readonly batchSize?: number;
  /** Default 15 s. */
  readonly heartbeatIntervalMs?: number;
  /** Default 3000 ms. */
  readonly retryMs?: number;
  /**
   * A stream is closed (without `end`) after this long; the browser reconnects with
   * `Last-Event-ID` and the replay continues. Default 1 hour.
   */
  readonly maxLifetimeMs?: number;
  /** Open replay streams per client IP; one more is 429 `too_many_streams`. Default 3. */
  readonly maxStreamsPerIp?: number;
}

export interface DemoReplayDeps {
  readonly source: RunEventSource;
  readonly logger: Logger;
  /** As on the live stream: `hidden` sends no cost values and `withheld` for `usage_recorded`. */
  readonly costs: RunCostVisibility;
  readonly options?: DemoReplayOptions;
  /** Aborted on shutdown: every open replay ends so `server.close()` can finish. */
  readonly shutdownSignal?: AbortSignal;
}

export interface ServeReplay {
  /** A demo run the caller resolved (listed and completed). */
  readonly runId: string;
  /** Counts against `maxStreamsPerIp`. */
  readonly clientKey: string;
  /** The validated cursor (`Last-Event-ID` or `?after=`). */
  readonly afterSeq: number;
  /** The validated `?speed=` (1 when absent). */
  readonly speed: number;
}

export interface DemoReplayStreams {
  serve(res: Response, request: ServeReplay): Promise<void>;
  /** Streams currently open (for tests and diagnostics). */
  activeCount(): number;
}

export function createDemoReplayStreams(deps: DemoReplayDeps): DemoReplayStreams {
  const maxGapMs = deps.options?.maxGapMs ?? DEFAULT_REPLAY_MAX_GAP_MS;
  const batchSize = deps.options?.batchSize ?? 200;
  const { source } = deps;
  const hub = createSseHub({
    logger: deps.logger,
    limits: {
      heartbeatIntervalMs: deps.options?.heartbeatIntervalMs ?? 15_000,
      retryMs: deps.options?.retryMs ?? 3000,
      maxLifetimeMs: deps.options?.maxLifetimeMs ?? 60 * 60 * 1000,
      maxStreamsPerKey: deps.options?.maxStreamsPerIp ?? 3,
      // Public, but a stream is never stored; `no-transform` keeps Caddy from buffering it.
      cacheControl: 'no-cache, no-transform',
    },
    ...(deps.shutdownSignal === undefined ? {} : { shutdownSignal: deps.shutdownSignal }),
    failureMessage: 'demo replay stream failed',
  });

  async function replay(session: SseSession, request: ServeReplay): Promise<void> {
    const { runId } = request;
    const timing: ReplayTiming = { maxGapMs, speed: request.speed };
    // A completed run never changes, so its head is read once.
    const head = await source.head(runId);
    if (session.isClosed() || head === undefined) return;
    let cursor = request.afterSeq;
    if (cursor > head.lastEventSeq) {
      // As on the live stream: continue from the real head and let the client refetch.
      cursor = head.lastEventSeq;
      await session.write(
        namedSseEvent(
          RUN_STREAM_RESYNC_EVENT,
          runStreamResyncSchema.parse({ lastEventSeq: head.lastEventSeq }),
        ),
      );
    }
    // On a resume, the event at the cursor (already delivered) anchors the first pause, so a
    // reconnect keeps the original rhythm instead of bursting.
    let previous: Date | undefined;
    if (cursor > 0) {
      const [anchor] = await source.events(runId, cursor - 1, 1);
      previous = anchor?.seq === cursor ? anchor.occurredAt : undefined;
    }
    while (!session.isClosed() && cursor < head.lastEventSeq) {
      const batch = await source.events(runId, cursor, batchSize);
      if (session.isClosed()) return;
      const due = batch.filter((event) => event.seq > cursor && event.seq <= head.lastEventSeq);
      if (due.length === 0) break;
      for (const event of due) {
        const delay = replayDelayMs(previous, event.occurredAt, timing);
        if (delay > 0) await session.sleep(delay);
        if (session.isClosed()) return;
        await session.write(formatRunEvent(disclosedEvent(event, deps.costs)));
        cursor = event.seq;
        previous = event.occurredAt;
      }
    }
    if (session.isClosed()) return;
    if (isRunStreamTerminal(head.status) && cursor >= head.lastEventSeq) {
      await session.write(
        namedSseEvent(
          RUN_STREAM_END_EVENT,
          runStreamEndSchema.parse({ status: head.status, lastEventSeq: head.lastEventSeq }),
        ),
      );
    }
  }

  return {
    serve: (res, request) =>
      hub.serve(res, request.clientKey, (session) => replay(session, request), {
        runId: request.runId,
      }),
    activeCount: () => hub.activeCount(),
  };
}
