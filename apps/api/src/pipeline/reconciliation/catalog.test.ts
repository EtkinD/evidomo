import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { buildCatalog, CatalogError } from './catalog.ts';
import { buildReconciliationRequests } from './call.ts';
import {
  RECONCILIATION_INCLUDED_CASSETTES,
  RECONCILIATION_MATCH,
  recordedReconciliationStep,
  replayRecordedCandidates,
  storedFact,
  type RecordedCandidates,
} from './testing.ts';

// The catalog built from the recorded P2-07 and P2-08 candidates (replayed, no spend): IDs,
// order, and what the model is and is not shown. Always replay mode: nothing here is recorded.

const replay = createMetaReplay({
  cassette: 'p2-08/vision-inventory',
  include: RECONCILIATION_INCLUDED_CASSETTES.filter((name) => name !== 'p2-08/vision-inventory'),
  match: RECONCILIATION_MATCH,
  mode: 'replay',
});
const TRANSCRIPT_ID = randomUUID();
const INVENTORY_ID = randomUUID();
let registry: DefinitionRegistry;
let recorded: RecordedCandidates;

beforeAll(async () => {
  registry = await loadDefinitions();
  await replay.start();
  const usage = createInMemoryUsageRecorder();
  const clients = createMetaClients({ apiKey: replay.apiKey, usage, maxRetries: 0 });
  recorded = await replayRecordedCandidates(clients, usage, registry, {
    transcriptArtifactId: TRANSCRIPT_ID,
    inventoryArtifactId: INVENTORY_ID,
  });
  replay.assertAllMatched();
}, 120_000);

afterAll(async () => {
  await replay.stop();
});

function catalogFrom(facts: RecordedCandidates['facts']) {
  return buildCatalog({
    market: registry.getMarket('nl', 1),
    facts: facts.map((fact) => storedFact('run', fact)),
    transcript: { artifactId: TRANSCRIPT_ID, turns: recorded.turns },
    inventory: recorded.inventory,
  });
}

describe('reconciliation catalog from the recorded candidates', () => {
  it('assigns content-derived IDs, so fact order and database IDs never change the request', () => {
    const catalog = catalogFrom(recorded.facts);
    const shuffled = catalogFrom([...recorded.facts].reverse());
    const step = recordedReconciliationStep(registry);
    expect(buildReconciliationRequests(step, shuffled.input).primary.prompt).toBe(
      buildReconciliationRequests(step, catalog.input).primary.prompt,
    );

    expect(catalog.items).toHaveLength(recorded.facts.length);
    expect(catalog.input.form.map((field) => field.id)).toEqual([
      'F.build_year',
      'F.energy_label',
      'F.ground_lease',
      'F.living_area',
      'F.place_name',
      'F.street_name',
      'F.vve_monthly_contribution',
    ]);
    // Opinions get an ID for the outcome list but are never sent.
    const opinions = catalog.items.filter((item) => item.assertion === 'opinion');
    expect(opinions.length).toBeGreaterThan(0);
    for (const opinion of opinions) expect(catalog.sent.has(opinion.evidenceId)).toBe(false);
    expect(catalog.input.candidates.length).toBe(
      catalog.items.filter((i) => i.sourceKind === 'transcript_turn').length - opinions.length,
    );
    // Photos: one per inventoried photo with facts, regions carry the fact key and count.
    expect(catalog.input.photos).toHaveLength(6);
    for (const photo of catalog.input.photos) {
      for (const observation of photo.observations) {
        expect(observation.key).toMatch(/^other:/);
        expect(observation.count).toBeGreaterThan(0);
      }
    }
    expect(catalog.input.inventory).toEqual([]);

    // The planted living-area values are all in the catalog.
    const living = catalog.items
      .filter((item) => item.key === 'living_area')
      .map((item) => [item.evidenceId.slice(0, 1), item.value, item.basis]);
    expect(living).toEqual([
      ['F', 92, 'NEN2580'],
      ['C', 92, 'NEN2580'],
      ['C', 95, 'unspecified'],
    ]);
  });

  it('refuses facts whose sources the run does not have', () => {
    const market = registry.getMarket('nl', 1);
    const facts = recorded.facts.map((fact) => storedFact('run', fact));
    expect(() =>
      buildCatalog({ market, facts, transcript: null, inventory: recorded.inventory }),
    ).toThrow(CatalogError);
    expect(() =>
      buildCatalog({
        market,
        facts,
        transcript: { artifactId: randomUUID(), turns: recorded.turns },
        inventory: recorded.inventory,
      }),
    ).toThrow('cites a different transcript');
    expect(() =>
      buildCatalog({
        market,
        facts,
        transcript: { artifactId: TRANSCRIPT_ID, turns: recorded.turns },
        inventory: null,
      }),
    ).toThrow('no photo inventory');
    expect(() =>
      buildCatalog({
        market,
        facts: facts.filter((fact) => fact.source.kind !== 'form'),
        transcript: { artifactId: TRANSCRIPT_ID, turns: recorded.turns },
        inventory: recorded.inventory,
      }),
    ).toThrow('no fact form candidates');
  });
});
