import { randomUUID } from 'node:crypto';
import type { MarketProfile } from '@evidomo/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Fact, NewFact } from '../../db/repositories/facts.ts';
import { loadDefinitions } from '../../definitions/loader.ts';
import { storedFact } from '../reconciliation/testing.ts';
import {
  buildCopyFactCatalog,
  CopyCatalogError,
  photoContext,
  type CopyInventoryView,
} from './catalog.ts';

let market: MarketProfile;
const TRANSCRIPT = randomUUID();
const PHOTO_A = randomUUID();
const PHOTO_B = randomUUID();
const region = { x: 0, y: 0, width: 1, height: 1 };

beforeAll(async () => {
  market = (await loadDefinitions()).getMarket('nl', 1);
});

function verified(fact: Omit<NewFact, 'stepId'>): Fact {
  return storedFact('run', { stepId: 'fact_extraction', status: 'verified', ...fact });
}
const form = (field: string, key: string, value: number | string | boolean, unit?: string) =>
  verified({ key, value, unit: unit ?? null, basis: null, source: { kind: 'form', field } });
const turn = (key: string, value: number | string | boolean, turnIndex = 1) =>
  verified({
    key,
    value,
    source: {
      kind: 'transcript_turn',
      transcriptArtifactId: TRANSCRIPT,
      turnIndex,
      startMs: 0,
      endMs: 1000,
      quote: 'q',
    },
  });
const photo = (key: string, materialId: string, count: number) =>
  verified({ key, value: count, source: { kind: 'photo_region', materialId, region } });

function inventory(): CopyInventoryView {
  return {
    photos: [
      { materialId: PHOTO_A, classification: { status: 'ok', subject: 'bedroom', coverRank: 2 } },
      { materialId: randomUUID(), classification: { status: 'failed' } },
      {
        materialId: PHOTO_B,
        classification: { status: 'ok', subject: 'living_room', coverRank: 1 },
      },
    ],
  };
}

describe('copy fact catalog', () => {
  it('groups equal facts, lists market facts first, and assigns content-derived IDs', () => {
    const facts = [
      turn('other:dishwasher', true),
      form('living_area', 'living_area', 92, 'm2'),
      turn('living_area', 92),
      form('energy_label', 'energy_label', 'B'),
      turn('other:balcony_area', 7),
    ];
    // The transcript fact for living area has no unit and basis here, so it is its own group.
    const catalog = buildCopyFactCatalog(market, facts, null);
    expect(catalog.facts.map((f) => [f.id, f.key, f.value])).toEqual([
      ['VF01', 'energy_label', 'B'],
      ['VF02', 'living_area', 92],
      ['VF03', 'living_area', 92],
      ['VF04', 'other:balcony_area', 7],
      ['VF05', 'other:dishwasher', true],
    ]);
    expect(catalog.facts[0]?.label).toBe('Energy label (energielabel)');
    expect(catalog.facts[3]?.label).toBeNull();

    // Same facts in another order (other database IDs): the same IDs for the same content.
    const again = buildCopyFactCatalog(market, [...facts].reverse(), null);
    expect(again.facts.map((f) => [f.id, f.key, f.value, f.unit])).toEqual(
      catalog.facts.map((f) => [f.id, f.key, f.value, f.unit]),
    );
  });

  it('maps one catalog ID to every stored fact that states the same value', () => {
    const a = form('vve_monthly_contribution', 'vve_monthly_contribution', 165, 'EUR');
    const b = { ...turn('vve_monthly_contribution', 165), unit: 'EUR' };
    const catalog = buildCopyFactCatalog(market, [a, b], null);
    expect(catalog.facts).toHaveLength(1);
    expect([...(catalog.byId.get('VF01')?.factIds ?? [])].sort()).toEqual([a.id, b.id].sort());
  });

  it('turns photo facts into presences with their rooms and never exposes their counts', () => {
    const facts = [photo('other:window', PHOTO_A, 2), photo('other:window', PHOTO_B, 3)];
    const catalog = buildCopyFactCatalog(market, facts, inventory());
    expect(catalog.facts).toEqual([
      expect.objectContaining({
        id: 'VF01',
        key: 'other:window',
        value: true,
        presence: true,
        seenIn: ['bedroom', 'living_room'],
      }),
    ]);
    expect(catalog.facts[0]?.factIds).toHaveLength(2);
  });

  it('cites Gate 1 decisions like any verified fact', () => {
    const decision = verified({
      key: 'other:bedroom_floor',
      value: 'carpet',
      source: {
        kind: 'gate_decision',
        gate: 'fact_conflicts',
        conflictsArtifactId: randomUUID(),
        conflictId: 'K01',
      },
    });
    const catalog = buildCopyFactCatalog(market, [decision], null);
    expect(catalog.facts[0]).toMatchObject({ value: 'carpet', factIds: [decision.id] });
  });

  it('refuses unverified facts, opinions, non-scalar values, and an empty set', () => {
    const candidate = { ...turn('other:x', 1), status: 'candidate' as const };
    expect(() => buildCopyFactCatalog(market, [candidate], null)).toThrow(CopyCatalogError);
    const opinion = { ...turn('other:x', true), assertion: 'opinion' as const };
    expect(() => buildCopyFactCatalog(market, [opinion], null)).toThrow(CopyCatalogError);
    const object = { ...turn('other:x', 1), value: { a: 1 } };
    expect(() => buildCopyFactCatalog(market, [object], null)).toThrow(CopyCatalogError);
    expect(() => buildCopyFactCatalog(market, [], null)).toThrow('no verified facts');
  });
});

describe('photo context', () => {
  it('lists room subjects in cover-rank order and the cover subject', () => {
    expect(photoContext(inventory())).toEqual({
      cover: 'living_room',
      rooms: ['living_room', 'bedroom'],
    });
    expect(photoContext(null)).toBeNull();
  });
});
