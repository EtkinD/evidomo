import type { ServiceDefinition } from '@evidomo/shared';
import type { DefinitionRegistry } from '../definitions/loader.ts';

// TEMPORARY (P3-10), until roadmap cut level 1 is decided at CP1: `listing-launch` v1 still lists
// the `qa_cards` step (agent `qa_writer`, P3-03), which has no handler, so a real run would fail
// there. The headless CLI and its test run a copy of the definition without that step, under the
// same ID and version. When the YAML entry is removed (or P3-03 lands), delete this file and use
// `registry.getService` / the registry itself directly in ./run.ts and ./project.ts; the filter is
// a no-op by then, and the recorded run does not depend on it (no request names the step).

/** The step this CLI drops from every service definition while P3-03 is unresolved. */
export const DEFERRED_STEP_ID = 'qa_cards';

/** A copy of `service` without the deferred `qa_cards` step (unchanged if it has none). */
export function withoutDeferredSteps(service: ServiceDefinition): ServiceDefinition {
  if (!service.steps.some((step) => step.id === DEFERRED_STEP_ID)) return service;
  return { ...service, steps: service.steps.filter((step) => step.id !== DEFERRED_STEP_ID) };
}

/** The registry the run engine sees: every service with the deferred step filtered out. */
export function cliServiceRegistry(
  registry: Pick<DefinitionRegistry, 'getService' | 'services'>,
): Pick<DefinitionRegistry, 'getService' | 'services'> {
  const services = registry.services.map(withoutDeferredSteps);
  return {
    services,
    getService: (id, version) => withoutDeferredSteps(registry.getService(id, version)),
  };
}
