import type { Response } from 'express';
import { errorForLog, sendError } from '../http/errors.ts';
import type { Logger } from '../logger.ts';

// The server-sent-events plumbing both run streams share (docs/architecture.md §5 "Run API" and
// "Demo API"): headers, `retry:`, heartbeats, the lifetime limit, the per-key open stream cap,
// backpressure, and cleanup on client disconnect, shutdown, or failure. What a stream sends is
// its `body`: the live monitor polls for new events, the demo replays stored ones with their
// original timing.

export interface SseLimits {
  /** SSE comment interval, so idle proxies and browsers keep the connection. */
  readonly heartbeatIntervalMs: number;
  /** Reconnect delay the browser uses after a dropped stream (`retry:`). */
  readonly retryMs: number;
  /** A stream is closed (without `end`) after this long; the browser reconnects. */
  readonly maxLifetimeMs: number;
  /** Open streams per key (user or client IP); one more is refused with 429 `too_many_streams`. */
  readonly maxStreamsPerKey: number;
  /** `Cache-Control` of the stream; always with `no-transform`, so Caddy never buffers it. */
  readonly cacheControl: string;
}

/** What a stream body can do; every method is a no-op once the stream is closed. */
export interface SseSession {
  /** True once the client left, the lifetime is up, or the server is shutting down. */
  isClosed(): boolean;
  /** Writes a chunk, waiting for `drain` (or the end of the stream) when the buffer is full. */
  write(chunk: string): Promise<void>;
  /** Waits `ms`, or less when the stream closes meanwhile. */
  sleep(ms: number): Promise<void>;
}

export interface SseHubDeps {
  readonly logger: Logger;
  readonly limits: SseLimits;
  /** Aborted on shutdown: every open stream ends so `server.close()` can finish. */
  readonly shutdownSignal?: AbortSignal;
  /** Logged (with the stream's context) when a body throws. */
  readonly failureMessage: string;
}

export interface SseHub {
  /**
   * Serves one stream on `res` until `body` returns, the client disconnects, the lifetime is up,
   * or shutdown, then ends the response. Answers 429 `too_many_streams` (JSON, before any stream
   * byte) when `key` has too many open streams. Resolves once every timer is cleared and the
   * body has returned.
   */
  serve(
    res: Response,
    key: string,
    body: (session: SseSession) => Promise<void>,
    logContext: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  /** Streams currently open (for tests and diagnostics). */
  activeCount(): number;
}

/** A named SSE event (`event:` + JSON `data:`), e.g. `end` or `resync`. */
export function namedSseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSseHub({
  logger,
  limits,
  shutdownSignal,
  failureMessage,
}: SseHubDeps): SseHub {
  const perKey = new Map<string, number>();
  // A function, not an inline check: TypeScript would keep the earlier check's narrowing.
  const shuttingDown = (): boolean => shutdownSignal?.aborted === true;
  let active = 0;

  async function serve(
    res: Response,
    key: string,
    body: (session: SseSession) => Promise<void>,
    logContext: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    let closed = false;
    let wake: (() => void) | undefined;
    const close = (): void => {
      closed = true;
      wake?.();
    };
    const detach = (): void => {
      res.off('close', close);
      shutdownSignal?.removeEventListener('abort', close);
    };
    res.on('close', close);
    shutdownSignal?.addEventListener('abort', close, { once: true });
    // The client may have gone while the caller awaited its checks: 'close' was then emitted
    // before the listener existed.
    if (res.destroyed || res.writableEnded || shuttingDown()) {
      detach();
      return;
    }

    const open = perKey.get(key) ?? 0;
    if (open >= limits.maxStreamsPerKey) {
      detach();
      res.set('Cache-Control', 'no-store');
      sendError(res, 429, 'too_many_streams');
      return;
    }
    perKey.set(key, open + 1);
    active += 1;

    let timer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const lifetime = setTimeout(close, limits.maxLifetimeMs);

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
      if (closed) return Promise.resolve();
      return new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          timer = undefined;
          wake = undefined;
          resolve();
        };
        wake = done;
        timer = setTimeout(done, ms);
      });
    }

    try {
      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': limits.cacheControl,
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      res.flushHeaders();
      res.socket?.setNoDelay(true);
      heartbeat = setInterval(() => {
        // A comment line: ignored by EventSource, keeps proxies from timing the stream out.
        // Skipped while the buffer is full, so a stalled client cannot grow it.
        if (!closed && res.writableNeedDrain !== true) res.write(': ping\n\n');
      }, limits.heartbeatIntervalMs);
      await write(`retry: ${limits.retryMs}\n\n`);
      await body({ isClosed: () => closed, write, sleep });
    } catch (error) {
      // Headers are sent: end the stream; the browser reconnects with Last-Event-ID.
      logger.error({ err: errorForLog(error), ...logContext }, failureMessage);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timer);
      clearTimeout(lifetime);
      detach();
      if (!res.writableEnded && !res.destroyed) {
        if (shuttingDown()) {
          // A keep-alive socket would hold `server.close()` open until its idle timeout.
          const socket = res.socket;
          res.end(() => socket?.end());
        } else {
          res.end();
        }
      }
      const remaining = (perKey.get(key) ?? 1) - 1;
      if (remaining <= 0) perKey.delete(key);
      else perKey.set(key, remaining);
      active -= 1;
    }
  }

  return { serve, activeCount: () => active };
}
