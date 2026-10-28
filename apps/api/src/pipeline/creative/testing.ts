// Test support for the creative copy step, shared by the record/replay tests and the integration
// test so all of them send exactly the request the P3-01 fixtures were recorded with. The facts
// are the post-Gate-1 state of the recorded walkthrough (fictional): the P2-07/P2-08 candidates,
// the recorded P2-09 Wonder judgment, and one Gate 1 `edit` decision, all rebuilt from earlier
// cassettes in both modes. Imported only by tests.
import { randomUUID } from 'node:crypto';
import type {
  OfficeProfile,
  PhotoInventoryContent,
  ServiceDefinition,
  StoredTranscriptTurn,
} from '@evidomo/shared';
import type { Fact, NewFact } from '../../db/repositories/facts.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type { MetaClients } from '../../meta/clients.ts';
import type { UsageRecorder } from '../../meta/usage.ts';
import type { StepConfig } from '../../runs/steps.ts';
import { GATE_DECISION_STEP_ID } from '../../gates/fact-conflicts.ts';
import { buildReconciliationRequests, callReconciliation } from '../reconciliation/call.ts';
import { buildCatalog } from '../reconciliation/catalog.ts';
import { resolveReconciliation } from '../reconciliation/resolve.ts';
import {
  RECONCILIATION_CASSETTE,
  RECONCILIATION_INCLUDED_CASSETTES,
  recordedReconciliationStep,
  replayRecordedCandidates,
  storedFact,
} from '../reconciliation/testing.ts';
import { buildCopyFactCatalog, photoContext } from './catalog.ts';
import type { CopySources } from './generate.ts';

export const COPY_CASSETTES = { en: 'p3-01/copy-en', nl: 'p3-01/copy-nl' } as const;
export type RecordedCopyLanguage = keyof typeof COPY_CASSETTES;
/** The earlier steps' recordings, served read-only (`createMetaReplay({ include })`). */
export const COPY_INCLUDED_CASSETTES = [
  ...RECONCILIATION_INCLUDED_CASSETTES,
  RECONCILIATION_CASSETTE,
] as const;
export { RECONCILIATION_MATCH as COPY_MATCH } from '../reconciliation/testing.ts';

/** The office profile the fixtures were recorded with (fictional agency). */
export const RECORDED_OFFICE_PROFILE: OfficeProfile = {
  agencyName: 'Example Makelaardij',
  tone: 'Warm and professional; short, concrete sentences.',
};

/**
 * The operator's Gate 1 decision on the recorded conflict (walkthrough "laminate floor" vs the
 * bedroom photo's carpet): an `edit`, so the copy input contains a `gate_decision` fact.
 */
export const RECORDED_GATE_EDIT = { key: 'other:bedroom_floor', value: 'carpet' } as const;

/**
 * The creative step of `listing-launch` v1 with the settings the fixtures were recorded with,
 * so they keep matching if the definition's defaults change later.
 */
export function recordedCopyStep(
  registry: Pick<DefinitionRegistry, 'getService'>,
): StepConfig<'creative'> {
  const service = registry.getService('listing-launch', 1);
  const step = service.steps.find((candidate) => candidate.agent === 'creative');
  if (step?.agent !== 'creative') throw new Error('listing-launch v1 has no creative step');
  const { fallback_model: _model, fallback_reasoning_effort: _effort, ...rest } = step;
  return { ...rest, model: 'muse-spark-1.3', reasoning_effort: 'medium', max_output_tokens: 16000 };
}

/** Creative copy, then an export stand-in, so a test can see the run complete. */
export function creativeService(
  registry: Pick<DefinitionRegistry, 'getService'>,
): ServiceDefinition {
  const service = registry.getService('listing-launch', 1);
  return {
    ...service,
    id: 'creative-copy',
    steps: [recordedCopyStep(registry), { id: 'export', agent: 'exporter' }],
  };
}

export interface PostGateFacts {
  readonly turns: StoredTranscriptTurn[];
  readonly inventory: PhotoInventoryContent;
  /** Every fact of the run after Gate 1, with its status (verified, rejected) set. */
  readonly facts: NewFact[];
}

/**
 * The run's facts after reconciliation and Gate 1, built with the steps' own code: candidates
 * from the P2-07/P2-08 replays, statuses from the replayed P2-09 Wonder answer, and the conflict
 * resolved by {@link RECORDED_GATE_EDIT} the way the Gate 1 API applies an `edit` (every
 * conflicted fact rejected, one new verified `gate_decision` fact).
 */
export async function replayPostGateFacts(
  clients: MetaClients,
  usage: UsageRecorder,
  registry: Pick<DefinitionRegistry, 'getService' | 'getMarket'>,
  ids: {
    readonly transcriptArtifactId: string;
    readonly inventoryArtifactId: string;
    readonly conflictsArtifactId: string;
  },
): Promise<PostGateFacts> {
  const recorded = await replayRecordedCandidates(clients, usage, registry, ids);
  const market = registry.getMarket('nl', 1);
  const stored = recorded.facts.map((fact) => storedFact('run', fact));
  const catalog = buildCatalog({
    market,
    facts: stored,
    transcript: { artifactId: ids.transcriptArtifactId, turns: recorded.turns },
    inventory: recorded.inventory,
  });
  const { primary } = buildReconciliationRequests(
    recordedReconciliationStep(registry),
    catalog.input,
  );
  const answer = await callReconciliation(clients, primary);
  const result = resolveReconciliation(market, catalog, answer.output);
  const statusOf = new Map(result.outcomes.map((outcome) => [outcome.factId, outcome.status]));
  const [conflict, ...others] = result.conflicts;
  if (conflict === undefined || others.length > 0 || conflict.key !== RECORDED_GATE_EDIT.key) {
    throw new Error('The recorded reconciliation no longer has the one expected conflict');
  }
  const facts: NewFact[] = stored.map((fact) => {
    const status = statusOf.get(fact.id);
    if (status === undefined) throw new Error('A recorded candidate has no outcome');
    return {
      stepId: fact.stepId,
      key: fact.key,
      value: fact.value,
      unit: fact.unit,
      basis: fact.basis,
      source: fact.source,
      assertion: fact.assertion,
      status: status === 'conflicted' ? 'rejected' : status,
    };
  });
  facts.push({
    stepId: GATE_DECISION_STEP_ID,
    key: RECORDED_GATE_EDIT.key,
    value: RECORDED_GATE_EDIT.value,
    unit: null,
    basis: null,
    source: {
      kind: 'gate_decision',
      gate: 'fact_conflicts',
      conflictsArtifactId: ids.conflictsArtifactId,
      conflictId: conflict.id,
    },
    status: 'verified',
    assertion: 'stated',
  });
  return { turns: recorded.turns, inventory: recorded.inventory, facts };
}

/** Fresh placeholder IDs for {@link replayPostGateFacts} (none of them reaches the prompt). */
export function placeholderArtifactIds(): {
  transcriptArtifactId: string;
  inventoryArtifactId: string;
  conflictsArtifactId: string;
} {
  return {
    transcriptArtifactId: randomUUID(),
    inventoryArtifactId: randomUUID(),
    conflictsArtifactId: randomUUID(),
  };
}

/** The copy sources the handler builds for these facts, without a database. */
export function recordedCopySources(
  registry: Pick<DefinitionRegistry, 'getMarket'>,
  facts: readonly Fact[],
  inventory: PhotoInventoryContent,
  outputLanguage: RecordedCopyLanguage,
): CopySources {
  const market = registry.getMarket('nl', 1);
  return {
    market,
    catalog: buildCopyFactCatalog(
      market,
      facts.filter((fact) => fact.status === 'verified'),
      inventory,
    ),
    photos: photoContext(inventory),
    tone: RECORDED_OFFICE_PROFILE.tone ?? null,
    outputLanguage,
    revision: null,
  };
}
