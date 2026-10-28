// Test support for the reconciliation step, shared by the record/replay tests and the
// integration test so all of them send exactly the request the P2-09 fixtures were recorded
// with. The candidates are the recorded P2-07 extraction (fictional walkthrough, fictional form)
// and the recorded P2-08 inventory of the six synthetic interiors, replayed from their own
// cassettes in both modes. Imported only by tests.
import { randomUUID } from 'node:crypto';
import {
  photoInventoryContentSchema,
  type FactSource,
  type JsonValue,
  type PhotoInventoryContent,
  type ServiceDefinition,
  type StoredTranscriptTurn,
} from '@evidomo/shared';
import type { Fact, NewFact } from '../../db/repositories/facts.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type { MetaClients } from '../../meta/clients.ts';
import type { UsageRecorder } from '../../meta/usage.ts';
import type { StepConfig } from '../../runs/steps.ts';
import { factFormToCandidates } from '../extraction/form.ts';
import {
  buildFactExtractionRequest,
  callFactExtraction,
  toFormFact,
  toTranscriptFact,
} from '../extraction/handler.ts';
import { normalizeExtractedFacts } from '../extraction/normalize.ts';
import {
  EXTRACTION_CASSETTE,
  EXTRACTION_INCLUDED_CASSETTES,
  replayWalkthroughTurns,
  walkthroughExtractionStep,
} from '../extraction/testing.ts';
import { WALKTHROUGH_FACT_FORM, walkthroughMarket } from '../intake/testing.ts';
import { toPhotoFact } from '../vision/handler.ts';
import { runVisionInventory, visionSettings } from '../vision/inventory.ts';
import {
  loadSamplePhotos,
  sampleVisionStep,
  VISION_CASSETTE,
  VISION_INCLUDED_CASSETTES,
} from '../vision/testing.ts';

export const RECONCILIATION_CASSETTE = 'p2-09/reconciliation-wonder';
export const RECONCILIATION_FALLBACK_CASSETTE = 'p2-09/reconciliation-spark-fallback';
/** The earlier steps' recordings, served read-only (`createMetaReplay({ include })`). */
export const RECONCILIATION_INCLUDED_CASSETTES = [
  ...EXTRACTION_INCLUDED_CASSETTES,
  EXTRACTION_CASSETTE,
  ...VISION_INCLUDED_CASSETTES,
  VISION_CASSETTE,
] as const;
export { EXTRACTION_MATCH as RECONCILIATION_MATCH } from '../extraction/testing.ts';

/**
 * The reconciliation step of `listing-launch` v1 with the settings the fixtures were recorded
 * with, so they keep matching if the definition's defaults change later.
 */
export function recordedReconciliationStep(
  registry: Pick<DefinitionRegistry, 'getService'>,
): StepConfig<'reconciler'> {
  const service = registry.getService('listing-launch', 1);
  const step = service.steps.find((candidate) => candidate.agent === 'reconciler');
  if (step?.agent !== 'reconciler') throw new Error('listing-launch v1 has no reconciler step');
  return {
    ...step,
    model: 'muse-wonder-1.0',
    reasoning_effort: 'low',
    max_output_tokens: 12000,
    fallback_model: 'muse-spark-1.3',
    fallback_reasoning_effort: 'medium',
    gate_after: 'fact_conflicts',
  };
}

/** Reconciliation, then an export stand-in, so a test can see the run continue past Gate 1. */
export function reconciliationService(
  registry: Pick<DefinitionRegistry, 'getService'>,
): ServiceDefinition {
  const service = registry.getService('listing-launch', 1);
  return {
    ...service,
    id: 'reconciliation-gate',
    steps: [recordedReconciliationStep(registry), { id: 'export', agent: 'exporter' }],
  };
}

/** A stored fact as the repository returns it (for tests that skip the database). */
export function storedFact(runId: string, fact: NewFact): Fact {
  const now = new Date('2026-10-28T00:00:00Z');
  return {
    id: randomUUID(),
    runId,
    stepId: fact.stepId,
    key: fact.key,
    value: fact.value,
    unit: fact.unit ?? null,
    basis: fact.basis ?? null,
    source: fact.source,
    status: fact.status ?? 'candidate',
    assertion: fact.assertion ?? 'stated',
    createdAt: now,
    updatedAt: now,
  };
}

export interface RecordedCandidates {
  readonly turns: StoredTranscriptTurn[];
  readonly inventory: PhotoInventoryContent;
  /** Form and transcript facts (citing `transcriptArtifactId`) and photo facts. */
  readonly facts: NewFact[];
}

/**
 * The candidates the extraction and vision steps store for the recorded inputs, built with the
 * same requests, normalization, and fact mapping. Every call replays from an earlier cassette.
 */
export async function replayRecordedCandidates(
  clients: MetaClients,
  usage: UsageRecorder,
  registry: Pick<DefinitionRegistry, 'getService' | 'getMarket'>,
  ids: { readonly transcriptArtifactId: string; readonly inventoryArtifactId: string },
): Promise<RecordedCandidates> {
  const market = walkthroughMarket(registry);
  const turns = await replayWalkthroughTurns(clients, usage, registry);
  const extraction = await callFactExtraction(
    clients,
    buildFactExtractionRequest({ step: walkthroughExtractionStep(registry), market, turns }),
  );
  const accepted = normalizeExtractedFacts(market, turns, extraction.facts).accepted;
  const vision = await runVisionInventory(
    { clients, meter: async (_modelId, call) => call() },
    visionSettings(sampleVisionStep(registry), market),
    await loadSamplePhotos(),
  );
  const facts: NewFact[] = [
    ...factFormToCandidates(WALKTHROUGH_FACT_FORM, market).candidates.map((candidate) =>
      toFormFact('fact_extraction', candidate),
    ),
    ...accepted.map((candidate) =>
      toTranscriptFact('fact_extraction', ids.transcriptArtifactId, candidate),
    ),
    ...vision.facts.map((draft) => toPhotoFact('vision_inventory', ids.inventoryArtifactId, draft)),
  ];
  return { turns, inventory: photoInventoryContentSchema.parse(vision.content), facts };
}

/** A minimal fact for unit tests. */
export function newFact(
  key: string,
  value: JsonValue,
  source: FactSource,
  extra: Partial<Pick<NewFact, 'unit' | 'basis' | 'assertion'>> = {},
): NewFact {
  return {
    stepId: source.kind === 'photo_region' ? 'vision_inventory' : 'fact_extraction',
    key,
    value,
    unit: extra.unit ?? null,
    basis: extra.basis ?? null,
    source,
    assertion: extra.assertion ?? 'stated',
  };
}
