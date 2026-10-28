import { randomUUID } from 'node:crypto';
import { STAGED_IMAGE_LABEL } from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fact } from '../../db/repositories/facts.ts';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { storedFact } from '../reconciliation/testing.ts';
import { evaluatePublicationChecklist, type ChecklistCopySegment } from './evaluate.ts';
import {
  CHECKLIST_REPLAY,
  placeholderArtifactIds,
  replayPostGateFacts,
  replayRecordedNlCopy,
} from './testing.ts';

// Both market checklists against the recorded walkthrough's post-Gate-1 facts (the P2-07/P2-08
// candidates, the replayed P2-09 Wonder judgment, and the Gate 1 edit) and its recorded "nl"
// copy (P3-01). Replay only, forced: the test makes no model call and never writes a cassette.

const replay = createMetaReplay(CHECKLIST_REPLAY);
let registry: DefinitionRegistry;
let facts: Fact[];
let segments: ChecklistCopySegment[];

beforeAll(async () => {
  registry = await loadDefinitions();
  await replay.start();
  const usage = createInMemoryUsageRecorder();
  const clients = createMetaClients({ apiKey: replay.apiKey, usage, maxRetries: 0 });
  const recorded = await replayPostGateFacts(clients, usage, registry, placeholderArtifactIds());
  facts = recorded.facts.map((fact) => storedFact('run', fact));
  const copy = await replayRecordedNlCopy(clients, registry, facts, recorded.inventory);
  replay.assertAllMatched();
  // The final draft as Gate 2 would see it: one claim per segment, no decisions yet.
  segments = copy.variants.flatMap((variant) =>
    variant.segments.map((segment) => ({
      claimId: randomUUID(),
      variant: variant.kind,
      factIds: segment.factIds,
      decision: null,
    })),
  );
});

afterAll(async () => {
  await replay.stop();
});

const allCategories = [
  'claim_support',
  'unverifiable_superlative',
  'investment_promise',
  'exclusionary',
  'area_basis',
] as const;

describe('the publication checklist on the recorded walkthrough', () => {
  it('passes nl: the verified energy label is cited in the copy; no staged image is approved', () => {
    const market = registry.getMarket('nl', 1);
    const energyLabel = facts.filter(
      (fact) => fact.key === 'energy_label' && fact.status === 'verified',
    );
    expect(energyLabel.length).toBeGreaterThan(0);

    const result = evaluatePublicationChecklist({
      market,
      facts,
      copy: { segments },
      claimAudit: { auditedCategories: allCategories, remainingFlags: [] },
      stagedImages: [],
    });

    expect(result.summary).toEqual({
      readyToPublish: true,
      counts: { items: 2, pass: 1, fail: 0, notApplicable: 1 },
    });
    const [label, staging] = result.items;
    expect(label).toMatchObject({
      id: 'energy_label_shown',
      status: 'pass',
      factIds: energyLabel.filter((fact) => fact.source.kind !== 'photo_region').map((f) => f.id),
    });
    // The recorded nl copy cites the energy label in the portal description.
    expect(label?.rule === 'fact_present' ? label.citedIn : []).toContain('portal');
    expect(staging).toMatchObject({ id: 'staging_disclosed', status: 'not_applicable' });
  });

  it('fails nl when Gate 1 had rejected the energy label', () => {
    const withoutLabel = facts.map((fact) =>
      fact.key === 'energy_label' ? { ...fact, status: 'rejected' as const } : fact,
    );
    const result = evaluatePublicationChecklist({
      market: registry.getMarket('nl', 1),
      facts: withoutLabel,
      copy: { segments },
      claimAudit: { auditedCategories: allCategories, remainingFlags: [] },
      stagedImages: [],
    });
    expect(result.summary.readyToPublish).toBe(false);
    expect(result.items[0]).toMatchObject({ id: 'energy_label_shown', status: 'fail' });
  });

  it('evaluates international on the same pack: staging and phrasing, Gate 2 decisions applied', () => {
    const market = registry.getMarket('international', 1);
    const [first, second] = segments;
    if (first === undefined || second === undefined) throw new Error('The copy has segments');
    const flags = [
      { category: 'investment_promise' as const, claimId: first.claimId },
      { category: 'exclusionary' as const, claimId: second.claimId },
    ];
    const staged = {
      artifactId: randomUUID(),
      disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true },
    };
    const evaluate = (decided: boolean) =>
      evaluatePublicationChecklist({
        market,
        facts,
        copy: {
          segments: segments.map((segment) =>
            decided && segment.claimId === first.claimId
              ? { ...segment, decision: 'edit' as const }
              : decided && segment.claimId === second.claimId
                ? { ...segment, decision: 'remove' as const }
                : segment,
          ),
        },
        claimAudit: { auditedCategories: allCategories, remainingFlags: flags },
        stagedImages: [staged],
      });

    const open = evaluate(false);
    expect(open.items.map((item) => [item.id, item.status])).toEqual([
      ['staging_disclosed', 'pass'],
      ['no_exclusionary_language', 'fail'],
      ['no_investment_promises', 'fail'],
    ]);
    expect(open.summary.readyToPublish).toBe(false);

    const decided = evaluate(true);
    expect(decided.items.map((item) => [item.id, item.status])).toEqual([
      ['staging_disclosed', 'pass'],
      ['no_exclusionary_language', 'pass'],
      ['no_investment_promises', 'pass'],
    ]);
    expect(decided.summary).toEqual({
      readyToPublish: true,
      counts: { items: 3, pass: 3, fail: 0, notApplicable: 0 },
    });
  });
});
