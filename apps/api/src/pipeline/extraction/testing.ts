// Test support for the fact extraction step, shared by the record/replay test and the
// integration test so both send exactly the request `fixtures/meta/p2-07/fact-extraction.json`
// was recorded with. The transcript is the P2-06 replay of the fictional P1-04 walkthrough.
// Imported only by tests.
import type { ServiceDefinition, StoredTranscriptTurn } from '@evidomo/shared';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import { encodePcm16Wav } from '../../media/wav.ts';
import type { MetaClients } from '../../meta/clients.ts';
import type { MatchOptions } from '../../meta/fixtures.ts';
import { transcribeAudio } from '../../meta/transcribe.ts';
import type { UsageRecorder } from '../../meta/usage.ts';
import type { StepConfig } from '../../runs/steps.ts';
import { buildIntakeTranscribeRequest } from '../intake/handler.ts';
import {
  INTAKE_CASSETTE,
  WALKTHROUGH_FACT_FORM,
  walkthroughIntakeStep,
  walkthroughMarket,
} from '../intake/testing.ts';
import { toStoredTurns } from '../intake/turns.ts';

export const EXTRACTION_CASSETTE = 'p2-07/fact-extraction';
/** Served read-only next to the extraction cassette (`createMetaReplay({ include })`). */
export const EXTRACTION_INCLUDED_CASSETTES = [INTAKE_CASSETTE] as const;
/** The intake cassette matches the audio part by name and type only (see P2-06). */
export const EXTRACTION_MATCH: MatchOptions = { ignoreFileContentFields: ['audio'] };

/**
 * The extraction step of `listing-launch` v1 with the settings the cassette was recorded with,
 * so the fixture keeps matching if the definition's defaults change later.
 */
export function walkthroughExtractionStep(
  registry: Pick<DefinitionRegistry, 'getService'>,
): StepConfig<'extractor'> {
  const service = registry.getService('listing-launch', 1);
  const step = service.steps.find((candidate) => candidate.agent === 'extractor');
  if (step?.agent !== 'extractor') throw new Error('listing-launch v1 has no extractor step');
  return { ...step, model: 'muse-spark-1.3', reasoning_effort: 'low', max_output_tokens: 14000 };
}

/** A copy of `listing-launch` v1 that runs only intake and fact extraction. */
export function intakeAndExtractionService(
  registry: Pick<DefinitionRegistry, 'getService'>,
): ServiceDefinition {
  const service = registry.getService('listing-launch', 1);
  return {
    ...service,
    id: 'intake-extraction',
    steps: [walkthroughIntakeStep(registry), walkthroughExtractionStep(registry)],
  };
}

/**
 * The stored turns the intake step produces for the walkthrough, through the same request and
 * turn processing (replayed from the P2-06 cassette with a silent 1-second WAV).
 */
export async function replayWalkthroughTurns(
  clients: MetaClients,
  usage: UsageRecorder,
  registry: Pick<DefinitionRegistry, 'getService' | 'getMarket'>,
): Promise<StoredTranscriptTurn[]> {
  const step = walkthroughIntakeStep(registry);
  const request = buildIntakeTranscribeRequest({
    step,
    market: walkthroughMarket(registry),
    factForm: WALKTHROUGH_FACT_FORM,
    audio: encodePcm16Wav(new Int16Array(16_000), 16_000),
    durationMs: 1000,
  });
  const transcript = await transcribeAudio({ openai: clients.openai, usage }, request);
  return toStoredTurns(transcript.turns, {
    maxTurnMs: step.max_turn_seconds === undefined ? null : step.max_turn_seconds * 1000,
  });
}
