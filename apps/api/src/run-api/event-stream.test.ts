import type { Server } from 'node:http';
import net from 'node:net';
import {
  RUN_STREAM_END_EVENT,
  RUN_STREAM_RESYNC_EVENT,
  apiErrorSchema,
  runStreamEndSchema,
  runStreamEventSchema,
  runStreamResyncSchema,
  type RunStatus,
} from '@evidomo/shared';
import express from 'express';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRunEventStreams,
  type RunEventSource,
  type RunEventStreamOptions,
  type RunEventStreams,
  type StreamedRunEvent,
} from './event-stream.ts';
import { openSse, type SseConnection, type SseMessage } from './testing.ts';

// The stream loop over real HTTP with an in-memory event source: replay from a cursor, live
// delivery, the end event, heartbeats, and that a disconnect or shutdown clears every timer and
// stops querying. The PostgreSQL-backed source is covered by run-api.integration.test.ts.

const RUN_ID = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const logger = pino({ enabled: false });

class FakeRun {
  status: RunStatus = 'running';
  readonly stored: StreamedRunEvent[] = [];
  headCalls = 0;
  eventCalls = 0;

  append(type: string, payload: unknown): void {
    this.stored.push({
      seq: this.stored.length + 1,
      type,
      payload,
      occurredAt: new Date(Date.UTC(2026, 9, 29, 10, 0, this.stored.length)),
    });
  }

  usage(cost: string): void {
    this.append('usage_recorded', { stepId: 'intake', stepCostUsd: cost, runCostUsd: cost });
  }

  finish(status: 'completed' | 'failed'): void {
    this.append('run_status_changed', {
      from: this.status,
      to: status,
      ...(status === 'failed' ? { reason: 'Step "intake" failed after 2 executions' } : {}),
    });
    this.status = status;
  }

  readonly source: RunEventSource = {
    head: (runId) => {
      this.headCalls += 1;
      return Promise.resolve(
        runId === RUN_ID ? { status: this.status, lastEventSeq: this.stored.length } : undefined,
      );
    },
    events: (_runId, afterSeq, limit) => {
      this.eventCalls += 1;
      return Promise.resolve(this.stored.filter((e) => e.seq > afterSeq).slice(0, limit));
    },
  };
}

let server: Server | undefined;
const connections: SseConnection[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.abort();
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

interface Harness {
  streams: RunEventStreams;
  port: number;
  open: (after?: number, user?: string) => Promise<SseConnection>;
  /** A raw HTTP/1.1 request on a socket the test controls (for aborts and backpressure). */
  raw: (path: string) => Promise<net.Socket>;
}

async function startStreams(
  run: FakeRun,
  options: RunEventStreamOptions & {
    shutdownSignal?: AbortSignal;
    /** Delay before `serve`, standing in for the route's ownership query. */
    handlerDelayMs?: number;
  } = {},
): Promise<Harness> {
  const { shutdownSignal, handlerDelayMs, ...streamOptions } = options;
  const streams = createRunEventStreams({
    source: run.source,
    logger,
    options: { pollIntervalMs: 20, heartbeatIntervalMs: 60_000, ...streamOptions },
    ...(shutdownSignal === undefined ? {} : { shutdownSignal }),
  });
  const app = express();
  app.get('/stream', async (req, res) => {
    const after = typeof req.query['after'] === 'string' ? Number(req.query['after']) : 0;
    const user = typeof req.query['user'] === 'string' ? req.query['user'] : 'user-1';
    if (handlerDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, handlerDelayMs));
    }
    await streams.serve(res, { runId: RUN_ID, userId: user, afterSeq: after });
  });
  const listening = app.listen(0);
  server = listening;
  await new Promise<void>((resolve) => listening.once('listening', () => resolve()));
  const address = listening.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  const { port } = address;
  return {
    streams,
    port,
    async open(after = 0, user = 'user-1') {
      const connection = await openSse(
        `http://127.0.0.1:${port}/stream?after=${after}&user=${user}`,
      );
      connections.push(connection);
      return connection;
    },
    raw: (path) =>
      new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
          resolve(socket);
        });
        sockets.push(socket);
      }),
  };
}

const events = (messages: SseMessage[]) =>
  messages
    .filter((m) => m.data !== undefined && m.event === undefined)
    .map((m) => ({ id: m.id, event: runStreamEventSchema.parse(JSON.parse(m.data ?? '')) }));

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('createRunEventStreams', () => {
  it('replays stored events with their seq as id, then sends end and closes on a terminal run', async () => {
    const run = new FakeRun();
    run.usage('0.01');
    run.usage('0.02');
    run.finish('completed');
    const { streams, open } = await startStreams(run);

    const stream = await open();
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers.get('cache-control')).toBe('private, no-cache, no-transform');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    expect(stream.headers.get('content-encoding')).toBeNull();
    await stream.closed();

    const messages = stream.messages();
    expect(messages[0]?.retry).toBe('3000');
    expect(events(messages).map((e) => [e.id, e.event.seq, e.event.type])).toEqual([
      ['1', 1, 'usage_recorded'],
      ['2', 2, 'usage_recorded'],
      ['3', 3, 'run_status_changed'],
    ]);
    const end = messages.at(-1);
    expect(end?.event).toBe(RUN_STREAM_END_EVENT);
    expect(end?.id).toBeUndefined();
    expect(runStreamEndSchema.parse(JSON.parse(end?.data ?? ''))).toEqual({
      status: 'completed',
      lastEventSeq: 3,
    });
    await until(() => streams.activeCount() === 0);
  });

  it('resumes after the cursor without repeating events', async () => {
    const run = new FakeRun();
    run.usage('0.01');
    run.usage('0.02');
    run.usage('0.03');
    run.finish('failed');
    const { open } = await startStreams(run);

    const fromQuery = await open(2);
    await fromQuery.closed();
    expect(events(fromQuery.messages()).map((e) => e.event.seq)).toEqual([3, 4]);

    const caughtUp = await open(4);
    await caughtUp.closed();
    expect(events(caughtUp.messages())).toEqual([]);
    expect(caughtUp.messages().at(-1)?.event).toBe(RUN_STREAM_END_EVENT);
  });

  it('delivers events as they are appended and keeps the stream open while the run runs', async () => {
    const run = new FakeRun();
    run.usage('0.01');
    const { open } = await startStreams(run);

    const stream = await open();
    await stream.until((messages) => events(messages).length === 1);
    run.usage('0.02');
    await stream.until((messages) => events(messages).length === 2);
    run.append('gate_opened', { gate: 'fact_conflicts', stepId: 'reconcile' });
    await stream.until((messages) => events(messages).length === 3);
    expect(stream.messages().some((m) => m.event === RUN_STREAM_END_EVENT)).toBe(false);

    run.finish('completed');
    await stream.closed();
    expect(events(stream.messages()).map((e) => e.event.type)).toEqual([
      'usage_recorded',
      'usage_recorded',
      'gate_opened',
      'run_status_changed',
    ]);
  });

  it('reads a long backlog in batches, in order', async () => {
    const run = new FakeRun();
    for (let i = 1; i <= 7; i += 1) run.usage(`0.0${i}`);
    run.finish('completed');
    const { open } = await startStreams(run, { batchSize: 2 });

    const stream = await open();
    await stream.closed();
    expect(events(stream.messages()).map((e) => e.event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(run.eventCalls).toBeGreaterThanOrEqual(4);
  });

  it('sends heartbeat comments while idle', async () => {
    const run = new FakeRun();
    const { open } = await startStreams(run, { heartbeatIntervalMs: 15 });

    const stream = await open();
    await stream.until((messages) => messages.filter((m) => m.comment).length >= 2);
  });

  it('stops querying and clears its timers when the client disconnects', async () => {
    const run = new FakeRun();
    run.usage('0.01');
    const { streams, open } = await startStreams(run, { heartbeatIntervalMs: 10 });

    const stream = await open();
    await stream.until((messages) => events(messages).length === 1);
    expect(streams.activeCount()).toBe(1);
    stream.abort();

    await until(() => streams.activeCount() === 0);
    const calls = run.headCalls + run.eventCalls;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(run.headCalls + run.eventCalls).toBe(calls);
  });

  it('ends every open stream on shutdown', async () => {
    const run = new FakeRun();
    const shutdown = new AbortController();
    const { streams, open } = await startStreams(run, { shutdownSignal: shutdown.signal });

    const first = await open();
    const second = await open();
    await until(() => streams.activeCount() === 2);
    shutdown.abort();

    await first.closed();
    await second.closed();
    await until(() => streams.activeCount() === 0);
    expect(first.messages().some((m) => m.event === RUN_STREAM_END_EVENT)).toBe(false);
  });

  it('ends the stream without an end event when the run disappears', async () => {
    const run = new FakeRun();
    run.usage('0.01');
    const { streams, open } = await startStreams(run);
    const stream = await open();
    await stream.until((messages) => events(messages).length === 1);

    run.source.head = () => Promise.resolve(undefined);
    await stream.closed();
    expect(stream.messages().some((m) => m.event === RUN_STREAM_END_EVENT)).toBe(false);
    await until(() => streams.activeCount() === 0);
  });
  it('never starts a stream for a client that left before serve (no timers, no queries)', async () => {
    const run = new FakeRun();
    const { streams, raw } = await startStreams(run, {
      handlerDelayMs: 100,
      heartbeatIntervalMs: 10,
    });

    const socket = await raw('/stream');
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(streams.activeCount()).toBe(0);
    expect(run.headCalls + run.eventCalls).toBe(0);
  });

  it('waits for drain while the client is not reading, resumes, and stops on close', async () => {
    const run = new FakeRun();
    const padding = 'x'.repeat(16 * 1024);
    for (let i = 0; i < 400; i += 1) run.append('usage_recorded', { padding });
    run.finish('completed');
    const { streams, raw } = await startStreams(run, { batchSize: 20 });

    // Not reading: the server's writes fill the socket buffers and it must stop at `drain`.
    const socket = await raw('/stream');
    socket.pause();
    await until(() => run.eventCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stalledAt = run.eventCalls;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(run.eventCalls).toBe(stalledAt);
    expect(stalledAt).toBeLessThan(400 / 20);
    expect(streams.activeCount()).toBe(1);

    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    socket.resume();
    await until(() => received.includes(`event: ${RUN_STREAM_END_EVENT}`), 5000);
    expect(received).toContain('id: 401\n');
    await until(() => streams.activeCount() === 0);

    // A second stalled client that goes away mid-wait releases the stream too.
    const stalled = await raw('/stream');
    stalled.pause();
    await until(() => streams.activeCount() === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    stalled.destroy();
    await until(() => streams.activeCount() === 0);
  });

  it('resyncs a cursor beyond the run head instead of skipping later events', async () => {
    const run = new FakeRun();
    run.usage('0.01');
    run.usage('0.02');
    const { open } = await startStreams(run);

    const stream = await open(999);
    await stream.until((messages) => messages.some((m) => m.event === RUN_STREAM_RESYNC_EVENT));
    const resync = stream.messages().find((m) => m.event === RUN_STREAM_RESYNC_EVENT);
    expect(runStreamResyncSchema.parse(JSON.parse(resync?.data ?? ''))).toEqual({
      lastEventSeq: 2,
    });

    run.usage('0.03');
    run.finish('completed');
    await stream.closed();
    expect(events(stream.messages()).map((e) => e.event.seq)).toEqual([3, 4]);
    const end = stream.messages().at(-1);
    expect(runStreamEndSchema.parse(JSON.parse(end?.data ?? ''))).toEqual({
      status: 'completed',
      lastEventSeq: 4,
    });
  });

  it('streams a row the schemas reject as stored and keeps going', async () => {
    const run = new FakeRun();
    run.usage('0.01');
    run.append('step_teleported', ['not', 'an', 'object']);
    run.usage('0.02');
    run.finish('completed');
    const { open } = await startStreams(run);

    const stream = await open();
    await stream.closed();
    const data = stream
      .messages()
      .filter((m) => m.event === undefined && m.data !== undefined)
      .map((m) => JSON.parse(m.data ?? '') as unknown);
    expect(data).toHaveLength(4);
    expect(data[1]).toMatchObject({
      seq: 2,
      type: 'step_teleported',
      payload: ['not', 'an', 'object'],
    });
    expect(runStreamEventSchema.safeParse(data[1]).success).toBe(false);
    expect(stream.messages().at(-1)?.event).toBe(RUN_STREAM_END_EVENT);
  });

  it('closes a stream after its maximum lifetime, without end, so the client reconnects', async () => {
    const run = new FakeRun();
    const { streams, open } = await startStreams(run, { maxLifetimeMs: 80 });

    const stream = await open();
    await stream.closed();
    expect(stream.messages().some((m) => m.event === RUN_STREAM_END_EVENT)).toBe(false);
    await until(() => streams.activeCount() === 0);
  });

  it('refuses a stream beyond the per-user cap with 429 too_many_streams', async () => {
    const run = new FakeRun();
    const { streams, port, open } = await startStreams(run, { maxStreamsPerUser: 2 });

    const first = await open(0, 'alice');
    await open(0, 'alice');
    await until(() => streams.activeCount() === 2);

    const refused = await fetch(`http://127.0.0.1:${port}/stream?user=alice`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('content-type')).toMatch(/^application\/json/);
    expect(apiErrorSchema.parse(await refused.json()).error).toBe('too_many_streams');

    // Another user is not affected, and a closed stream frees its slot.
    await open(0, 'bob');
    first.abort();
    await until(() => streams.activeCount() === 2);
    const again = await open(0, 'alice');
    expect(again.status).toBe(200);
  });
});
