import { randomUUID } from 'node:crypto';
import {
  portalOtherFactSchema,
  portalPresenceSchema,
  portalProfileFieldSchema,
  type MarketProfile,
  type PortalProfileField,
} from '@evidomo/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Fact, NewFact } from '../db/repositories/facts.ts';
import { loadDefinitions } from '../definitions/loader.ts';
import { evaluatePublicationChecklist } from '../pipeline/checklist/evaluate.ts';
import { storedFact } from '../pipeline/reconciliation/testing.ts';
import { buildPortalFacts } from './facts.ts';
import { inventoryContent, inventoryEntry } from './testing.ts';

// The fact part of the portal fields: typed profile fields with the checklist's rule, `other:`
// facts, and photo presences without numbers. Synthetic facts on the real `nl` v1 profile.

let nl: MarketProfile;
const LIVING = randomUUID();

beforeAll(async () => {
  nl = (await loadDefinitions()).getMarket('nl', 1);
});

function verified(fact: Omit<NewFact, 'stepId'>): Fact {
  return storedFact('run', { stepId: 'reconciliation', status: 'verified', ...fact });
}
const form = (
  key: string,
  value: number | string | boolean,
  unit: string | null = null,
  basis: string | null = null,
) => verified({ key, value, unit, basis, source: { kind: 'form', field: key } });
const photoFact = (key: string, value: number) =>
  verified({
    key,
    value,
    source: {
      kind: 'photo_region',
      materialId: LIVING,
      region: { x: 0, y: 0, width: 1, height: 1 },
    },
  });

const inventory = inventoryContent([
  inventoryEntry({
    materialId: LIVING,
    sha256: 'a'.repeat(64),
    subject: 'living_room',
    coverRank: 1,
    privacy: { status: 'clear' },
  }),
]);

function field(fields: readonly PortalProfileField[], key: string): PortalProfileField {
  const found = fields.find((f) => f.key === key);
  if (found === undefined) throw new Error(`no field ${key}`);
  return found;
}

describe('buildPortalFacts', () => {
  it('lists every profile fact in profile order as a typed field', () => {
    const facts = [
      form('energy_label', 'B'),
      form('living_area', 92, 'm2', 'NEN2580'),
      form('build_year', 1932),
      form('ground_lease', false),
      form('vve_monthly_contribution', 145.5, 'EUR'),
    ];
    const { profile } = buildPortalFacts(nl, facts, inventory);
    expect(profile.map((f) => f.key)).toEqual(nl.facts.map((f) => f.key));
    for (const entry of profile)
      expect(portalProfileFieldSchema.safeParse(entry).success).toBe(true);

    expect(field(profile, 'energy_label')).toMatchObject({
      type: 'enum',
      status: 'verified',
      value: 'B',
      sources: ['form'],
    });
    expect(field(profile, 'living_area')).toMatchObject({
      type: 'area',
      value: 92,
      unit: 'm2',
      basis: { id: 'NEN2580', label: expect.stringContaining('NEN 2580') as string },
    });
    expect(field(profile, 'build_year')).toMatchObject({ type: 'integer', value: 1932 });
    expect(field(profile, 'ground_lease')).toMatchObject({
      type: 'boolean',
      value: false,
      status: 'verified',
    });
    expect(field(profile, 'vve_monthly_contribution')).toMatchObject({
      type: 'money',
      value: 145.5,
      unit: 'EUR',
    });
    expect(field(profile, 'volume')).toMatchObject({
      status: 'missing',
      value: null,
      unit: 'm3',
      factIds: [],
    });
  });

  it('publishes no value for several different values or values off the profile measure', () => {
    const a = form('living_area', 92, 'm2', 'NEN2580');
    const b = form('living_area', 95, 'm2', 'NEN2580');
    const offBasis = form('plot_area', 120, 'm2', 'unspecified');
    const { profile } = buildPortalFacts(nl, [a, b, offBasis], inventory);
    expect(field(profile, 'living_area')).toMatchObject({ status: 'ambiguous', value: null });
    expect(field(profile, 'living_area').factIds).toEqual([a.id, b.id].sort());
    expect(field(profile, 'plot_area')).toMatchObject({ status: 'missing', value: null });
  });

  it('never takes a profile value from a photo, and keeps a gate decision as its source', () => {
    const decided = verified({
      key: 'build_year',
      value: 1932,
      source: {
        kind: 'gate_decision',
        gate: 'fact_conflicts',
        conflictsArtifactId: randomUUID(),
        conflictId: 'K01',
      },
    });
    const { profile } = buildPortalFacts(nl, [photoFact('volume', 3), decided], inventory);
    expect(field(profile, 'volume').status).toBe('missing');
    expect(field(profile, 'build_year')).toMatchObject({ value: 1932, sources: ['gate_decision'] });
  });

  it('keeps other: facts with their value and photo facts as presences without any number', () => {
    const { other, presences } = buildPortalFacts(
      nl,
      [
        form('energy_label', 'B'),
        form('other:station_cycling_time_minutes', 6),
        photoFact('other:balcony', 2),
      ],
      inventory,
    );
    expect(other).toEqual([
      expect.objectContaining({
        key: 'other:station_cycling_time_minutes',
        value: 6,
        sources: ['form'],
      }),
    ]);
    expect(presences).toEqual([
      { key: 'other:balcony', seenIn: ['living_room'], factIds: [expect.any(String) as string] },
    ]);
    expect(JSON.stringify(presences)).not.toMatch(/"value"|:2\b/);
    for (const entry of other) expect(portalOtherFactSchema.safeParse(entry).success).toBe(true);
    for (const entry of presences) expect(portalPresenceSchema.safeParse(entry).success).toBe(true);
  });

  it('agrees with the checklist: a passing fact_present item always has its value', () => {
    for (const facts of [
      [form('energy_label', 'B')],
      [form('energy_label', 'X')],
      [],
      [form('energy_label', 'B'), form('energy_label', 'C')],
    ]) {
      const checklist = evaluatePublicationChecklist({
        market: nl,
        facts,
        copy: { segments: [] },
        claimAudit: null,
        stagedImages: [],
      });
      const item = checklist.items.find(
        (i) => i.rule === 'fact_present' && i.fact === 'energy_label',
      );
      const energy = field(buildPortalFacts(nl, facts, inventory).profile, 'energy_label');
      expect(item?.status === 'pass').toBe(energy.status === 'verified');
      if (item?.rule === 'fact_present') expect(energy.factIds).toEqual([...item.factIds].sort());
    }
  });
});
