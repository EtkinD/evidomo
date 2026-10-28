// Test support for the publication checklist: the recorded walkthrough's post-Gate-1 facts and
// its recorded "nl" copy (P3-01), replayed from earlier cassettes. Replay is forced, so these
// tests never make a model call and never write a cassette. Imported only by tests.
import type { ListingCopyContent, PhotoInventoryContent } from '@evidomo/shared';
import type { Fact } from '../../db/repositories/facts.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type { MetaClients } from '../../meta/clients.ts';
import type { MetaReplayOptions } from '../../meta/replay.ts';
import { checkCopyOutput } from '../creative/check.ts';
import {
  buildCopyInput,
  buildCopyRequests,
  buildListingCopyContent,
  callCopy,
} from '../creative/generate.ts';
import {
  COPY_CASSETTES,
  COPY_INCLUDED_CASSETTES,
  COPY_MATCH,
  recordedCopySources,
  recordedCopyStep,
} from '../creative/testing.ts';

export { placeholderArtifactIds, replayPostGateFacts } from '../creative/testing.ts';

export const CHECKLIST_REPLAY: MetaReplayOptions = {
  cassette: COPY_CASSETTES.nl,
  include: COPY_INCLUDED_CASSETTES,
  match: COPY_MATCH,
  mode: 'replay',
};

/** The recorded "nl" copy for these facts, as the creative step builds it (revision 0). */
export async function replayRecordedNlCopy(
  clients: MetaClients,
  registry: Pick<DefinitionRegistry, 'getService' | 'getMarket'>,
  facts: readonly Fact[],
  inventory: PhotoInventoryContent,
): Promise<ListingCopyContent> {
  const sources = recordedCopySources(registry, facts, inventory, 'nl');
  const input = buildCopyInput(sources);
  const { primary } = buildCopyRequests(recordedCopyStep(registry), sources.market, input);
  const answer = await callCopy(clients, primary);
  return buildListingCopyContent({
    generated: {
      copy: checkCopyOutput(answer.output, sources.catalog, 'nl'),
      modelRun: {
        model: primary.modelId,
        reasoningEffort: primary.reasoningEffort,
        maxOutputTokens: primary.maxOutputTokens,
        fallbackFrom: null,
      },
    },
    catalog: sources.catalog,
    facts: sources.facts,
    input,
    revision: 0,
    previousArtifactId: null,
  });
}
