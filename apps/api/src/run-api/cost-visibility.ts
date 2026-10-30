import { RUN_STREAM_WITHHELD_TYPE, runStreamEventSchema } from '@evidomo/shared';
import { withoutBudgetDetails } from '../usage/budget.ts';
import type { StreamedRunEvent } from './event-stream.ts';

// Whether run responses disclose what runs cost (docs/architecture.md §10 "Cost visibility").
// Costs are an operator concern: `RUN_COSTS_VISIBLE` is on in development and test and off in
// production unless set. Hidden is enforced here, at the API, so the data never reaches a
// browser; the database, the usage ledger, and the budget checks are the same either way.

/** `RUN_COSTS_VISIBLE` as the run API and the demo API apply it. */
export type RunCostVisibility = 'visible' | 'hidden';

export function runCostVisibility(visible: boolean): RunCostVisibility {
  return visible ? 'visible' : 'hidden';
}

/** A stored failure reason or step error as the client may read it. */
export function disclosedReason(reason: string, costs: RunCostVisibility): string {
  return costs === 'visible' ? reason : withoutBudgetDetails(reason);
}

/** Event types that exist only to report spend. */
const COST_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(['usage_recorded']);

/**
 * The cost totals the stored step events carry. The stream schema has them optional, so they are
 * removed before the payload is checked against it; any other money key fails that check.
 */
const STEP_COST_KEYS: ReadonlySet<string> = new Set(['stepCostUsd', 'runCostUsd']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withheld(event: StreamedRunEvent): StreamedRunEvent {
  return {
    seq: event.seq,
    type: RUN_STREAM_WITHHELD_TYPE,
    payload: {},
    occurredAt: event.occurredAt,
  };
}

/**
 * A stored event as a client may see it. With costs hidden this is an allow-list: only a known
 * event type whose payload, without its step cost totals, matches the strict stream schema is
 * sent (its `reason` without budget details); everything else is `withheld` with the same seq,
 * so the client's sequence stays gapless and its cursor moves. That covers `usage_recorded`, a
 * type this server does not know, a payload with any extra key (`spentUsd`, `cost_usd`, nested
 * objects), and a corrupt row. Trade-off: in hidden mode such a row moves only the cursor
 * instead of making the client refetch; the snapshot catches up at the next refetch (`end`,
 * `resync`, focus on a finished run).
 */
export function disclosedEvent(
  event: StreamedRunEvent,
  costs: RunCostVisibility,
): StreamedRunEvent {
  if (costs === 'visible') return event;
  if (COST_ONLY_EVENT_TYPES.has(event.type) || !isPlainObject(event.payload)) {
    return withheld(event);
  }
  const candidate = Object.fromEntries(
    Object.entries(event.payload).filter(([key]) => !STEP_COST_KEYS.has(key)),
  );
  const parsed = runStreamEventSchema.safeParse({
    seq: event.seq,
    type: event.type,
    payload: candidate,
    occurredAt: event.occurredAt.toISOString(),
  });
  // `withheld` is a stream-only type; a stored row claiming it is not trusted either.
  if (!parsed.success || parsed.data.type === RUN_STREAM_WITHHELD_TYPE) return withheld(event);
  const payload: Record<string, unknown> = { ...parsed.data.payload };
  if (typeof payload['reason'] === 'string') {
    payload['reason'] = withoutBudgetDetails(payload['reason']);
  }
  return { seq: event.seq, type: parsed.data.type, payload, occurredAt: event.occurredAt };
}
