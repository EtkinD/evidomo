import type { ReconciledValue } from '@evidomo/shared';
import { UNSPECIFIED_BASIS } from '../extraction/schema.ts';

// Deterministic comparison of stated values (docs/architecture.md §5 step 4). Areas, volumes,
// and money are compared as value + unit + basis, and numbers are compared exactly: a stated
// number has no tolerance, because "92" and "92.5" are different claims and rounding is the
// copy writer's decision, not reconciliation's. The model never decides these comparisons.

export interface Measured {
  readonly key: string;
  readonly value: ReconciledValue;
  readonly unit: string | null;
  readonly basis: string | null;
}

export type MeasureRelation =
  /** Same quantity and value; or one side states no basis and the values are equal. */
  | { readonly relation: 'agree' }
  /** Same unit, same basis, different values: a contradiction a human must resolve. */
  | { readonly relation: 'contradict' }
  /** Different measures: neither support nor contradiction. */
  | { readonly relation: 'incomparable'; readonly reason: 'different_unit' | 'different_basis' };

/** Exact equality of two scalars: same JSON type and same value (no tolerance, no coercion). */
export function sameValue(a: ReconciledValue, b: ReconciledValue): boolean {
  return typeof a === typeof b && a === b;
}

/** Facts without a basis (non-areas) and areas whose basis was not stated compare alike. */
function basisOf(measured: Measured): string {
  return measured.basis ?? UNSPECIFIED_BASIS;
}

/**
 * The basis rule. Units must match. Two values on the same basis (both NEN 2580, both
 * unstated, or both non-areas) agree when equal and contradict when not. Two different named
 * bases are different measures. A value without a stated basis next to a named one supports it
 * when equal (the speaker said the same number) and is a different measure when not: "zo'n 95"
 * without a basis is not evidence against a NEN 2580 value of 92.
 */
export function compareMeasures(a: Measured, b: Measured): MeasureRelation {
  if (a.unit !== b.unit) return { relation: 'incomparable', reason: 'different_unit' };
  const basisA = basisOf(a);
  const basisB = basisOf(b);
  const equal = sameValue(a.value, b.value);
  if (basisA === basisB) return equal ? { relation: 'agree' } : { relation: 'contradict' };
  if (basisA !== UNSPECIFIED_BASIS && basisB !== UNSPECIFIED_BASIS) {
    return { relation: 'incomparable', reason: 'different_basis' };
  }
  return equal ? { relation: 'agree' } : { relation: 'incomparable', reason: 'different_basis' };
}

/** Groups items by exact value (insertion order kept), e.g. the sides of a conflict. */
export function groupByMeasure<T extends Measured>(items: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const group = groups.find((candidate) => {
      const [first] = candidate;
      return (
        first !== undefined &&
        first.key === item.key &&
        first.unit === item.unit &&
        first.basis === item.basis &&
        sameValue(first.value, item.value)
      );
    });
    if (group === undefined) groups.push([item]);
    else group.push(item);
  }
  return groups;
}

/** The measure a market fact is published on: the profile's unit and basis. */
export interface ProfileMeasure {
  readonly key: string;
  readonly unit: string | null;
  readonly basis: string | null;
}

export type ProfileComparison<T extends Measured> =
  /** No fact on the profile measure (e.g. only a basis-less area for an optional key). */
  | { readonly kind: 'none'; readonly offMeasure: readonly OffMeasure<T>[] }
  | {
      readonly kind: 'verified';
      /** Facts on the profile measure, all with the same value. */
      readonly members: readonly T[];
      /** Facts stated without a basis whose value equals the verified one. */
      readonly corroborating: readonly T[];
      readonly offMeasure: readonly OffMeasure<T>[];
    }
  | {
      readonly kind: 'conflict';
      /** Facts on the profile measure, grouped by value (two or more groups). */
      readonly sides: readonly (readonly T[])[];
      readonly offMeasure: readonly OffMeasure<T>[];
    };

export interface OffMeasure<T> {
  readonly item: T;
  readonly reason: 'different_unit' | 'different_basis';
}

/**
 * Reconciles the stated facts of one market key. Facts on the profile's measure (its unit and,
 * for areas, its basis) decide: one value is verified, several values are a conflict. Facts on
 * another measure are compared with the verified value only: a basis-less equal value
 * corroborates it; anything else is a different measure (kept out of the sheet, never a
 * conflict). Off-measure facts never decide or join a conflict, because they cannot say which
 * profile-measure value is right.
 */
export function compareProfileFacts<T extends Measured>(
  measure: ProfileMeasure,
  items: readonly T[],
): ProfileComparison<T> {
  const onMeasure = items.filter(
    (item) => item.unit === measure.unit && item.basis === measure.basis,
  );
  const off = items.filter((item) => !onMeasure.includes(item));
  const groups = groupByMeasure(onMeasure);
  const [first] = groups;

  if (first === undefined || groups.length > 1) {
    const offMeasure = off.map((item) => ({ item, reason: offReason(measure, item) }));
    if (first === undefined) return { kind: 'none', offMeasure };
    return { kind: 'conflict', sides: groups, offMeasure };
  }

  const [anchor] = first;
  if (anchor === undefined) throw new Error('A value group cannot be empty');
  const corroborating: T[] = [];
  const offMeasure: OffMeasure<T>[] = [];
  for (const item of off) {
    const relation = compareMeasures(anchor, item);
    if (relation.relation === 'agree') corroborating.push(item);
    else offMeasure.push({ item, reason: offReason(measure, item) });
  }
  return { kind: 'verified', members: first, corroborating, offMeasure };
}

function offReason(measure: ProfileMeasure, item: Measured): 'different_unit' | 'different_basis' {
  return item.unit === measure.unit ? 'different_basis' : 'different_unit';
}
