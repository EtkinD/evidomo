// Test support for the intake step, shared by the record/replay test and the integration test
// so both send exactly the request the cassette `fixtures/meta/p2-06/intake-transcribe.json`
// was recorded with. Imported only by tests.
import type { JsonObject, MarketProfile, ServiceDefinition } from '@evidomo/shared';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type { StepConfig } from '../../runs/steps.ts';

/** The cassette recorded from the P1-04 TTS walkthrough (see docs/model-notes.md, P2-06). */
export const INTAKE_CASSETTE = 'p2-06/intake-transcribe';

/**
 * A fact form for the fictional apartment of `fixtures/meta/p1-04/walkthrough-nl.txt`: invented
 * street and town, no real address or person. `street_name` and `place_name` stand in for the
 * base property fields that do not exist yet; typed market facts contribute no keywords.
 */
export const WALKTHROUGH_FACT_FORM: JsonObject = {
  street_name: 'Kwartelhoflaan',
  place_name: 'Zandmeer',
  energy_label: 'B',
  living_area: 92,
  build_year: 1987,
  vve_monthly_contribution: 165,
  ground_lease: false,
};

/**
 * The intake step of `listing-launch` v1, with the mode the cassette was recorded in, so the
 * fixture keeps matching if the definition's mode is changed later.
 */
export function walkthroughIntakeStep(
  registry: Pick<DefinitionRegistry, 'getService'>,
): StepConfig<'intake'> {
  const service = registry.getService('listing-launch', 1);
  const step = service.steps.find((candidate) => candidate.agent === 'intake');
  if (step?.agent !== 'intake') throw new Error('listing-launch v1 has no intake step');
  return { ...step, transcription_mode: 'DIARIZATION' };
}

/** A copy of `listing-launch` v1 that runs only the given intake step. */
export function intakeOnlyService(
  registry: Pick<DefinitionRegistry, 'getService'>,
  step: StepConfig<'intake'>,
): ServiceDefinition {
  const service = registry.getService('listing-launch', 1);
  return { ...service, id: 'intake-only', steps: [step] };
}

export function walkthroughMarket(registry: Pick<DefinitionRegistry, 'getMarket'>): MarketProfile {
  return registry.getMarket('nl', 1);
}
