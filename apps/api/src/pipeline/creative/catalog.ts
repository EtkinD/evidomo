import {
  reconciledValueSchema,
  type MarketProfile,
  type PhotoSubject,
  type ReconciledValue,
} from '@evidomo/shared';
import type { Fact } from '../../db/repositories/facts.ts';

// The facts the copy may cite (docs/architecture.md §5 Creative): the run's verified facts after
// Gate 1, grouped and given short, content-derived IDs (`VF01`, ...). Code maps every ID back to
// the stored facts, so provenance never passes through the model, and the same facts always
// produce the same request (and fixture hash), whatever their database IDs or insertion order.

/** One citable fact as the model sees it, with the stored facts it stands for. */
export interface CopyCatalogFact {
  readonly id: string;
  readonly key: string;
  /** The market profile's label for profile keys; null for `other:` keys. */
  readonly label: string | null;
  /**
   * The verified value. Photo-only facts are presences (`true`): their stored value is an
   * instance count in one photo, never a property total, so the model never sees it.
   */
  readonly value: ReconciledValue;
  readonly unit: string | null;
  readonly basis: string | null;
  /** Seen in photos: supports that something is there, never a count or measurement. */
  readonly presence: boolean;
  /** Rooms of the photos a presence was seen in (closed subject set), else empty. */
  readonly seenIn: readonly PhotoSubject[];
  /** Every stored fact behind this ID, in ID order. */
  readonly factIds: readonly string[];
}

/** The part of the photo inventory copy reads (a `PhotoInventoryContent` satisfies it). */
export interface CopyInventoryView {
  readonly photos: readonly {
    readonly materialId: string;
    readonly classification:
      | { readonly status: 'ok'; readonly subject: PhotoSubject; readonly coverRank: number }
      | { readonly status: 'failed' };
  }[];
}

export interface CopyFactCatalog {
  readonly facts: readonly CopyCatalogFact[];
  readonly byId: ReadonlyMap<string, CopyCatalogFact>;
}

/** The facts cannot be cited as given; a retry would fail the same way. */
export class CopyCatalogError extends Error {
  override name = 'CopyCatalogError';
}

const MAX_CATALOG_SIZE = 999;

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function scalar(fact: Fact): ReconciledValue {
  const parsed = reconciledValueSchema.safeParse(fact.value);
  if (!parsed.success) throw new CopyCatalogError('A verified fact has a non-scalar value');
  return parsed.data;
}

interface Group {
  readonly key: string;
  readonly value: ReconciledValue;
  readonly unit: string | null;
  readonly basis: string | null;
  readonly presence: boolean;
  readonly facts: Fact[];
}

/**
 * Groups the verified facts into citable entries: stated facts (form, transcript, gate
 * decision) by key + value + unit + basis, photo facts by key as presences.
 */
export function buildCopyFactCatalog(
  market: MarketProfile,
  facts: readonly Fact[],
  inventory: CopyInventoryView | null,
): CopyFactCatalog {
  const groups = new Map<string, Group>();
  for (const fact of facts) {
    if (fact.status !== 'verified') throw new CopyCatalogError('Only verified facts can be cited');
    // The database check already forbids verified opinions; opinions are never citable.
    if (fact.assertion !== 'stated') throw new CopyCatalogError('An opinion cannot be cited');
    const presence = fact.source.kind === 'photo_region';
    const value = presence ? true : scalar(fact);
    const unit = presence ? null : fact.unit;
    const basis = presence ? null : fact.basis;
    const groupKey = JSON.stringify([fact.key, presence, value, unit, basis]);
    const group = groups.get(groupKey) ?? {
      key: fact.key,
      value,
      unit,
      basis,
      presence,
      facts: [],
    };
    group.facts.push(fact);
    groups.set(groupKey, group);
  }
  if (groups.size === 0) throw new CopyCatalogError('The run has no verified facts to cite');
  if (groups.size > MAX_CATALOG_SIZE) {
    throw new CopyCatalogError(`The run has more than ${MAX_CATALOG_SIZE} citable facts`);
  }

  const profileOrder = new Map(market.facts.map((fact, i) => [fact.key, i]));
  const rank = (key: string): number => profileOrder.get(key) ?? market.facts.length;
  const ordered = [...groups.values()].sort(
    (a, b) =>
      rank(a.key) - rank(b.key) ||
      compareText(a.key, b.key) ||
      Number(a.presence) - Number(b.presence) ||
      compareText(JSON.stringify(a.value), JSON.stringify(b.value)) ||
      compareText(a.unit ?? '', b.unit ?? '') ||
      compareText(a.basis ?? '', b.basis ?? ''),
  );

  const subjectOf = new Map<string, PhotoSubject>();
  for (const photo of inventory?.photos ?? []) {
    if (photo.classification.status === 'ok') {
      subjectOf.set(photo.materialId, photo.classification.subject);
    }
  }
  const labelOf = new Map(market.facts.map((fact) => [fact.key, fact.label]));

  const catalogFacts = ordered.map((group, i): CopyCatalogFact => {
    const seenIn = new Set<PhotoSubject>();
    for (const fact of group.facts) {
      if (fact.source.kind !== 'photo_region') continue;
      const subject = subjectOf.get(fact.source.materialId);
      if (subject !== undefined && subject !== 'other') seenIn.add(subject);
    }
    return {
      id: `VF${String(i + 1).padStart(2, '0')}`,
      key: group.key,
      label: labelOf.get(group.key) ?? null,
      value: group.value,
      unit: group.unit,
      basis: group.basis,
      presence: group.presence,
      seenIn: [...seenIn].sort(compareText),
      factIds: group.facts.map((fact) => fact.id).sort(compareText),
    };
  });
  return { facts: catalogFacts, byId: new Map(catalogFacts.map((fact) => [fact.id, fact])) };
}

/** Subjects that are not rooms of the home, left out of the photo context. */
const NOT_A_ROOM: ReadonlySet<PhotoSubject> = new Set(['floor_plan', 'document', 'other']);

/** What the photos show, for ordering and emphasis only (never a source of claims). */
export interface CopyPhotoContext {
  /** The subject of the best-ranked cover photo. */
  readonly cover: PhotoSubject | null;
  /** Distinct room subjects in cover-rank order. */
  readonly rooms: readonly PhotoSubject[];
}

/**
 * The room list and cover subject from the photo inventory: closed-set subjects only, so no
 * model-written summary reaches the copy prompt.
 */
export function photoContext(inventory: CopyInventoryView | null): CopyPhotoContext | null {
  const classified = (inventory?.photos ?? []).flatMap((photo) =>
    photo.classification.status === 'ok' ? [photo.classification] : [],
  );
  if (classified.length === 0) return null;
  classified.sort((a, b) => a.coverRank - b.coverRank);
  const rooms = [
    ...new Set(classified.map((c) => c.subject).filter((subject) => !NOT_A_ROOM.has(subject))),
  ];
  const cover = classified[0]?.subject ?? null;
  return { cover: cover === null || NOT_A_ROOM.has(cover) ? null : cover, rooms };
}
