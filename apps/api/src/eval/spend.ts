import { z } from 'zod';
import type { Interaction } from '../meta/fixtures.ts';
import type { UsageEntry } from '../meta/usage.ts';

// Live spend of an eval set (docs/architecture.md §12): in record mode the usage ledger also
// meters responses served from a cassette, so the eval counts only calls whose response came
// from the live API.

const responseIdSchema = z.looseObject({
  id: z.string().optional(),
  sessionId: z.string().optional(),
});

/**
 * The ID the usage entry of a response carries (`responseId`): the Responses API `id`, or the
 * transcription's `sessionId`.
 */
export function interactionResponseId(interaction: Interaction): string | undefined {
  const body = interaction.response.body;
  if (body.type !== 'json') return undefined;
  const parsed = responseIdSchema.safeParse(body.value);
  if (!parsed.success) return undefined;
  return parsed.data.id ?? parsed.data.sessionId;
}

/**
 * Live spend of one set from its usage entries: calls whose response came from the live API.
 * A response served again from the cassette carries the same ID, so each live response counts
 * once. Image endpoints return no response ID: the first `imageRequests` entries without one
 * count as live (an image response served from a cassette may be among them, an over-count).
 */
export function liveUsage(
  entries: readonly UsageEntry[],
  live: { readonly responseIds: ReadonlyMap<string, number>; readonly imageRequests: number },
): { costUsd: number; calls: number; latencyMs: number } {
  const remaining = new Map(live.responseIds);
  let images = live.imageRequests;
  const liveEntries = entries.filter((entry) => {
    if (entry.responseId === undefined) {
      if (images === 0) return false;
      images -= 1;
      return true;
    }
    const left = remaining.get(entry.responseId) ?? 0;
    if (left === 0) return false;
    remaining.set(entry.responseId, left - 1);
    return true;
  });
  return {
    costUsd: liveEntries.reduce((sum, entry) => sum + (entry.estimatedCostUsd ?? 0), 0),
    calls: liveEntries.length,
    latencyMs: liveEntries.reduce((sum, entry) => sum + entry.latencyMs, 0),
  };
}
