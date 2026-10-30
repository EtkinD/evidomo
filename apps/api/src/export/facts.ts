import {
  FACT_SOURCE_KINDS,
  localizedLabel,
  type FactSourceKind,
  type MarketFact,
  type MarketProfile,
  type PortalFields,
  type PortalOtherFact,
  type PortalPresence,
  type PortalProfileField,
} from '@evidomo/shared';
import type { Fact } from '../db/repositories/facts.ts';
import { buildCopyFactCatalog, type CopyInventoryView } from '../pipeline/creative/catalog.ts';
import { isValidProfileValue, profileUnit } from '../pipeline/extraction/normalize.ts';

// The fact part of the portal fields (and of the HTML fact sheet, rendered from it): every
// market-profile fact as a typed field, verified `other:` facts, and what the photos show as
// presences. Pure. A profile field takes the same facts as the checklist's `fact_present` rule
// (verified, not from a photo, on the profile measure, valid for the fact), so an item that
// passes always has its value in the pack.

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function sourcesOf(facts: readonly Pick<Fact, 'source'>[]): FactSourceKind[] {
  const kinds = new Set(facts.map((fact) => fact.source.kind));
  return FACT_SOURCE_KINDS.filter((kind) => kinds.has(kind));
}

/** The facts carrying a profile fact's publishable value. */
export function profileFieldFacts(
  market: MarketProfile,
  marketFact: MarketFact,
  facts: readonly Fact[],
): Fact[] {
  const unit = profileUnit(market, marketFact);
  const basis = marketFact.type === 'area' ? marketFact.basis : null;
  return facts
    .filter(
      (fact) =>
        fact.status === 'verified' &&
        fact.key === marketFact.key &&
        fact.source.kind !== 'photo_region' &&
        fact.unit === unit &&
        fact.basis === basis &&
        isValidProfileValue(marketFact, fact.value),
    )
    .sort((a, b) => compareText(a.id, b.id));
}

function profileField(
  market: MarketProfile,
  marketFact: MarketFact,
  facts: readonly Fact[],
  language: string,
): PortalProfileField {
  const carrying = profileFieldFacts(market, marketFact, facts);
  // Facts are scalars, so the JSON text identifies a value exactly (92 ≠ "92").
  const values = new Set(carrying.map((fact) => JSON.stringify(fact.value)));
  const status = values.size === 0 ? 'missing' : values.size === 1 ? 'verified' : 'ambiguous';
  const value = status === 'verified' ? (carrying[0]?.value ?? null) : null;
  const common = {
    key: marketFact.key,
    label: localizedLabel(marketFact, language),
    required: marketFact.required,
    status,
    sources: sourcesOf(carrying),
    factIds: carrying.map((fact) => fact.id),
  } as const;
  switch (marketFact.type) {
    case 'enum':
      return {
        ...common,
        type: 'enum',
        value: typeof value === 'string' ? value : null,
        unit: null,
        basis: null,
      };
    case 'area': {
      const basis = market.area_bases.find((b) => b.id === marketFact.basis);
      return {
        ...common,
        type: 'area',
        value: typeof value === 'number' ? value : null,
        unit: market.units.area,
        basis: {
          id: marketFact.basis,
          label: basis === undefined ? marketFact.basis : localizedLabel(basis, language),
        },
      };
    }
    case 'volume':
      return {
        ...common,
        type: 'volume',
        value: typeof value === 'number' ? value : null,
        unit: market.units.volume ?? null,
        basis: null,
      };
    case 'integer':
      return {
        ...common,
        type: 'integer',
        value: typeof value === 'number' ? value : null,
        unit: null,
        basis: null,
      };
    case 'money':
      return {
        ...common,
        type: 'money',
        value: typeof value === 'number' ? value : null,
        unit: market.currency ?? null,
        basis: null,
      };
    case 'boolean':
      return {
        ...common,
        type: 'boolean',
        value: typeof value === 'boolean' ? value : null,
        unit: null,
        basis: null,
      };
    default: {
      const unreachable: never = marketFact;
      throw new Error(`Unhandled market fact type: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Builds `facts` of the portal fields from the run's verified facts. `other:` facts are grouped
 * like the copy catalog (key + value + unit + basis); photo facts become presences without any
 * number. Throws `CopyCatalogError` for facts the catalog refuses (an opinion). Profile field
 * and basis labels are in the pack's output language when the profile translates them (English
 * otherwise); values are never translated.
 */
export function buildPortalFacts(
  market: MarketProfile,
  facts: readonly Fact[],
  inventory: CopyInventoryView | null,
  language = 'en',
): PortalFields['facts'] {
  const verified = facts.filter((fact) => fact.status === 'verified');
  const profile = market.facts.map((marketFact) =>
    profileField(market, marketFact, verified, language),
  );
  const other: PortalOtherFact[] = [];
  const presences: PortalPresence[] = [];
  if (verified.length > 0) {
    const byId = new Map(verified.map((fact) => [fact.id, fact]));
    for (const entry of buildCopyFactCatalog(market, verified, inventory).facts) {
      if (!entry.key.startsWith('other:')) continue;
      const entryFacts = entry.factIds.flatMap((id) => {
        const fact = byId.get(id);
        return fact === undefined ? [] : [fact];
      });
      if (entry.presence) {
        presences.push({ key: entry.key, seenIn: [...entry.seenIn], factIds: [...entry.factIds] });
      } else {
        other.push({
          key: entry.key,
          value: entry.value,
          unit: entry.unit,
          basis: entry.basis,
          sources: sourcesOf(entryFacts),
          factIds: [...entry.factIds],
        });
      }
    }
  }
  return { profile, other, presences };
}
