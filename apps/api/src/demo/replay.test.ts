import type { Server } from 'node:http';
import {
  RUN_STREAM_END_EVENT,
  RUN_STREAM_RESYNC_EVENT,
  apiErrorSchema,
  runStreamEndSchema,
  runStreamEventSchema,
  runStreamResyncSchema,
} from '@evidomo/shared';
import express from 'express';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunCostVisibility } from '../run-api/cost-visibility.ts';
import type { RunEventSource, StreamedRunEvent } from '../run-api/event-stream.ts';
import { openSse, type SseConnection, type SseMessage } from '../run-api/testing.ts';
import {
  createDemoReplayStreams,
  replayDelayMs,
  type DemoReplayOptions,
  type DemoReplayStreams,
} from './replay.ts';

// The demo replay over real HTTP with an in-memory completed run: original spacing with long gaps
// capped and `speed` applied, resuming after a cursor (anchored on the delivered event), resync,
// the end event, and the cleanup guarantees it shares with the live stream (disconnect,
// lifetime, per-IP cap, shutdown). It only reads: the source has no write methods at all.

const RUN_ID = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const logger = pino({ enabled: false });
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);

describe('replayDelayMs', () => {
  const timing = { maxGapMs: 3000, speed: 1 };
  const at = (ms: number) => new Date(T0 + ms);

  it('starts at once and keeps short gaps as they were', () => {
    expect(replayDelayMs(undefined, at(0), timing)).toBe(0);
    expect(replayDelayMs(at(0), at(250), timing)).toBe(250);
    expect(replayDelayMs(at(0), at(0), timing)).toBe(0);
  });

  it('caps long gaps (a gate wait of hours) before the speed applies', () => {
    expect(replayDelayMs(at(0), at(4 * 60 * 60 * 1000), timing)).toBe(3000);
    expect(replayDelayMs(at(0), at(4 * 60 * 60 * 1000), { maxGapMs: 3000, speed: 2 })).toBe(1500);
    expect(replayDelayMs(at(0), at(1000), { maxGapMs: 3000, speed: 4 })).toBe(250);
    expect(replayDelayMs(at(0), at(1000), { maxGapMs: 3000, speed: 0.5 })).toBe(2000);
    expect(replayDelayMs(at(0), at(1001), { maxGapMs: 3000, speed: 3 })).toBe(334);
  });

  it('never waits a negative time when clocks went backwards', () => {
    expect(replayDelayMs(at(500), at(100), timing)).toBe(0);
  });
});

class StoredRun {
  readonly stored: StreamedRunEvent[] = [];
  headCalls = 0;
  eventCalls = 0;

  /** Appends an event `afterMs` after the previous one. */
  append(afterMs: number): void {
    const previous = this.stored.at(-1)?.occurredAt.getTime() ?? T0;
    const seq = this.stored.length + 1;
    this.stored.push({
      seq,
      type: 'usage_recorded',
      payload: { stepId: 'intake', stepCostUsd: '0.01', runCostUsd: `0.0${seq}` },
      occurredAt: new Date(previous + afterMs),
    });
  }

  readonly source: RunEventSource = {
    head: (runId) => {
      this.headCalls += 1;
      return Promise.resolve(
        runId === RUN_ID ? { status: 'completed', lastEventSeq: this.stored.length } : undefined,
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

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.abort();
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

interface Harness {
  streams: DemoReplayStreams;
  port: number;
  open: (query?: { after?: number; speed?: number; ip?: string }) => Promise<SseConnection>;
}

async function startReplay(
  run: StoredRun,
  options: DemoReplayOptions & { shutdownSignal?: AbortSignal; costs?: RunCostVisibility } = {},
): Promise<Harness> {
  const { shutdownSignal, costs = 'visible', ...replayOptions } = options;
  const streams = createDemoReplayStreams({
    source: run.source,
    logger,
    costs,
    options: { heartbeatIntervalMs: 60_000, maxGapMs: 200, ...replayOptions },
    ...(shutdownSignal === undefined ? {} : { shutdownSignal }),
  });
  const app = express();
  app.get('/replay', async (req, res) => {
    const number = (name: string, fallback: number) =>
      typeof req.query[name] === 'string' ? Number(req.query[name]) : fallback;
    await streams.serve(res, {
      runId: RUN_ID,
      clientKey: typeof req.query['ip'] === 'string' ? req.query['ip'] : 'ip-1',
      afterSeq: number('after', 0),
      speed: number('speed', 1),
    });
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
    async open({ after = 0, speed = 1, ip = 'ip-1' } = {}) {
      const connection = await openSse(
        `http://127.0.0.1:${port}/replay?after=${after}&speed=${speed}&ip=${ip}`,
      );
      connections.push(connection);
      return connection;
    },
  };
}

const events = (messages: SseMessage[]) =>
  messages
    .filter((m) => m.data !== undefined && m.event === undefined)
    .map((m) => ({ id: m.id, event: runStreamEventSchema.parse(JSON.parse(m.data ?? '')) }));

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Gaps 0 → 100 ms → 4 h (capped to 200 ms in these tests) → 50 ms: 350 ms at speed 1. */
function sampleRun(): StoredRun {
  const run = new StoredRun();
  run.append(0);
  run.append(100);
  run.append(4 * 60 * 60 * 1000);
  run.append(50);
  return run;
}

async function timedReplay(
  harness: Harness,
  query: { after?: number; speed?: number },
): Promise<{ elapsedMs: number; stream: SseConnection }> {
  const startedAt = performance.now();
  const stream = await harness.open(query);
  await stream.closed(5000);
  return { elapsedMs: performance.now() - startedAt, stream };
}

describe('createDemoReplayStreams', () => {
  it('replays every stored event as the live stream frames it, with the original spacing', async () => {
    const run = sampleRun();
    const harness = await startReplay(run);

    const { elapsedMs, stream } = await timedReplay(harness, {});
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    const messages = stream.messages();
    expect(messages[0]?.retry).toBe('3000');
    expect(events(messages).map((e) => [e.id, e.event.seq, e.event.occurredAt])).toEqual(
      run.stored.map((e) => [String(e.seq), e.seq, e.occurredAt.toISOString()]),
    );
    expect(runStreamEndSchema.parse(JSON.parse(messages.at(-1)?.data ?? ''))).toEqual({
      status: 'completed',
      lastEventSeq: 4,
    });
    expect(messages.at(-1)?.event).toBe(RUN_STREAM_END_EVENT);
    // 100 + 200 (the 4-hour gap, capped) + 50 ms; nowhere near the original hours.
    expect(elapsedMs).toBeGreaterThanOrEqual(330);
    expect(elapsedMs).toBeLessThan(3000);
    await until(() => harness.streams.activeCount() === 0);
  });

  it('applies the speed multiplier to the compressed timing', async () => {
    const harness = await startReplay(sampleRun());
    const fast = await timedReplay(harness, { speed: 4 });
    const slow = await timedReplay(harness, { speed: 0.5 });
    expect(events(fast.stream.messages())).toHaveLength(4);
    expect(events(slow.stream.messages())).toHaveLength(4);
    // 350 / 4 ≈ 88 ms and 350 / 0.5 = 700 ms.
    expect(fast.elapsedMs).toBeGreaterThanOrEqual(80);
    expect(slow.elapsedMs).toBeGreaterThanOrEqual(680);
    expect(fast.elapsedMs).toBeLessThan(slow.elapsedMs);
  });

  it('resumes after the cursor without repeats, keeping the gap from the delivered event', async () => {
    const run = sampleRun();
    const harness = await startReplay(run);

    const { elapsedMs, stream } = await timedReplay(harness, { after: 2 });
    expect(events(stream.messages()).map((e) => e.event.seq)).toEqual([3, 4]);
    // The pause before event 3 is measured from event 2 (capped at 200 ms), then 50 ms.
    expect(elapsedMs).toBeGreaterThanOrEqual(240);

    const caughtUp = await harness.open({ after: 4 });
    await caughtUp.closed();
    expect(events(caughtUp.messages())).toEqual([]);
    expect(caughtUp.messages().at(-1)?.event).toBe(RUN_STREAM_END_EVENT);
  });

  it('resyncs a cursor beyond the run, then ends', async () => {
    const harness = await startReplay(sampleRun());
    const stream = await harness.open({ after: 999 });
    await stream.closed();
    const resync = stream.messages().find((m) => m.event === RUN_STREAM_RESYNC_EVENT);
    expect(runStreamResyncSchema.parse(JSON.parse(resync?.data ?? ''))).toEqual({
      lastEventSeq: 4,
    });
    expect(events(stream.messages())).toEqual([]);
    expect(stream.messages().at(-1)?.event).toBe(RUN_STREAM_END_EVENT);
  });

  it('stops reading and clears its timers when the client disconnects mid-replay', async () => {
    const run = new StoredRun();
    run.append(0);
    for (let i = 0; i < 20; i += 1) run.append(1000);
    const harness = await startReplay(run, { maxGapMs: 100, batchSize: 2 });

    const stream = await harness.open();
    await stream.until((messages) => events(messages).length >= 2);
    stream.abort();
    await until(() => harness.streams.activeCount() === 0);
    const calls = run.headCalls + run.eventCalls;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(run.headCalls + run.eventCalls).toBe(calls);
  });

  it('closes after its maximum lifetime without end, so the client resumes with Last-Event-ID', async () => {
    const run = new StoredRun();
    run.append(0);
    run.append(10_000);
    run.append(10_000);
    const harness = await startReplay(run, { maxGapMs: 5000, maxLifetimeMs: 120 });

    const stream = await harness.open();
    await stream.closed();
    expect(events(stream.messages()).map((e) => e.event.seq)).toEqual([1]);
    expect(stream.messages().some((m) => m.event === RUN_STREAM_END_EVENT)).toBe(false);
    await until(() => harness.streams.activeCount() === 0);
  });

  it('refuses a stream beyond the per-IP cap with 429 too_many_streams', async () => {
    const run = new StoredRun();
    run.append(0);
    run.append(60_000);
    const harness = await startReplay(run, { maxGapMs: 60_000, maxStreamsPerIp: 1 });

    const first = await harness.open({ ip: 'ip-a' });
    await until(() => harness.streams.activeCount() === 1);
    const refused = await fetch(`http://127.0.0.1:${harness.port}/replay?ip=ip-a`);
    expect(refused.status).toBe(429);
    expect(apiErrorSchema.parse(await refused.json()).error).toBe('too_many_streams');

    await harness.open({ ip: 'ip-b' });
    first.abort();
    await until(() => harness.streams.activeCount() === 1);
    expect((await harness.open({ ip: 'ip-a' })).status).toBe(200);
  });

  it('ends every open replay on shutdown', async () => {
    const run = new StoredRun();
    run.append(0);
    run.append(60_000);
    const shutdown = new AbortController();
    const harness = await startReplay(run, {
      maxGapMs: 60_000,
      shutdownSignal: shutdown.signal,
    });

    const stream = await harness.open();
    await until(() => harness.streams.activeCount() === 1);
    shutdown.abort();
    await stream.closed();
    expect(stream.messages().some((m) => m.event === RUN_STREAM_END_EVENT)).toBe(false);
    await until(() => harness.streams.activeCount() === 0);
  });

  it('with run costs hidden, replays usage as withheld at the same seq and timing', async () => {
    const run = sampleRun();
    const harness = await startReplay(run, { costs: 'hidden' });

    const { elapsedMs, stream } = await timedReplay(harness, {});
    expect(events(stream.messages()).map((e) => [e.id, e.event.seq, e.event.type])).toEqual(
      run.stored.map((e) => [String(e.seq), e.seq, 'withheld']),
    );
    expect(events(stream.messages()).every((e) => Object.keys(e.event.payload).length === 0)).toBe(
      true,
    );
    expect(stream.text()).not.toMatch(/usage_recorded|CostUsd/);
    expect(runStreamEndSchema.parse(JSON.parse(stream.messages().at(-1)?.data ?? ''))).toEqual({
      status: 'completed',
      lastEventSeq: 4,
    });
    // The original rhythm is kept: a withheld message still occupies its event's moment.
    expect(elapsedMs).toBeGreaterThanOrEqual(330);
  });
});
