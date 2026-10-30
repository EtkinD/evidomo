import type { AreaUnit, VolumeUnit } from './definitions.ts';

// How a stored unit reads next to a number. The review screens (web) and the exported pack
// (api) share it, so a value the operator checked appears in the pack exactly as shown.

/** The display form of every area and volume unit a market profile can declare. */
export const UNIT_DISPLAY: Readonly<Record<AreaUnit | VolumeUnit, string>> = {
  m2: 'm²',
  sq_ft: 'sq ft',
  m3: 'm³',
  cu_ft: 'cu ft',
};

// A Map, so a stored unit that happens to name an Object.prototype member reads as stored.
const DISPLAY_BY_UNIT: ReadonlyMap<string, string> = new Map(Object.entries(UNIT_DISPLAY));

/** A stored unit as a person reads it: `m2` is `m²`; any other unit is shown as stored. */
export function displayUnit(unit: string): string {
  return DISPLAY_BY_UNIT.get(unit) ?? unit;
}

/**
 * Attaches a stored unit to an already formatted number: `92 m²`, `€ 450000`, or the number
 * alone when there is no unit. Number formatting (decimal separator) stays with the caller.
 */
export function withDisplayUnit(formattedNumber: string, unit: string | null): string {
  if (unit === null) return formattedNumber;
  if (unit === 'EUR') return `€ ${formattedNumber}`;
  return `${formattedNumber} ${displayUnit(unit)}`;
}
