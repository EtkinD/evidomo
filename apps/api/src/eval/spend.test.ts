import type { JsonValue } from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import type { Interaction } from '../meta/fixtures.ts';
import type { UsageEntry } from '../meta/usage.ts';
import { interactionResponseId, liveUsage } from './spend.ts';

function entry(responseId: string | undefined, cost: number, latencyMs = 10): UsageEntry {
  return {
    modelId: 'muse-spark-1.3',
    sdk: 'ai-sdk',
    responseId,
    latencyMs,
    estimatedCostUsd: cost,
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
    totalTokens: 2,
  };
}

function interaction(value: JsonValue): Interaction {
  return {
    request: { method: 'POST', path: '/v1/responses', bodySha256: '0'.repeat(64) },
    response: {
      status: 200,
      headers: {},
      body: { type: 'json', value },
    },
  };
}

describe('liveUsage', () => {
  it('counts each live response once, never the replays of it or served responses', () => {
    const usage = liveUsage(
      [
        entry('resp_live', 0.1, 1000),
        // The same request repeated in the session and served from the cassette.
        entry('resp_live', 0.1, 5),
        entry('resp_served', 0.3, 5),
        entry('resp_twice', 0.02),
        entry('resp_twice', 0.02),
      ],
      {
        responseIds: new Map([
          ['resp_live', 1],
          ['resp_twice', 2],
        ]),
        imageRequests: 0,
      },
    );
    expect(usage.calls).toBe(3);
    expect(usage.costUsd).toBeCloseTo(0.14, 10);
    expect(usage.latencyMs).toBe(1020);
  });

  it('counts image calls (no response ID) up to the live image requests', () => {
    const usage = liveUsage(
      [entry(undefined, 0.01), entry(undefined, 0.01), entry(undefined, 0.01)],
      {
        responseIds: new Map(),
        imageRequests: 2,
      },
    );
    expect(usage.calls).toBe(2);
    expect(usage.costUsd).toBeCloseTo(0.02, 10);
  });
});

describe('interactionResponseId', () => {
  it('reads the Responses API ID or the transcription session ID', () => {
    expect(interactionResponseId(interaction({ id: 'resp_1', output: [] }))).toBe('resp_1');
    expect(interactionResponseId(interaction({ sessionId: 'voyager/1', turns: [] }))).toBe(
      'voyager/1',
    );
    expect(interactionResponseId(interaction({ created: 1, data: [] }))).toBeUndefined();
  });
});
