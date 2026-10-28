import type { JsonObject, MarketProfile } from '@evidomo/shared';
import { isValidProfileValue, profileUnit } from './normalize.ts';
import { OTHER_KEY_PREFIX, OTHER_SLUG_PATTERN, type FormCandidate } from './schema.ts';

// Fact form → candidate facts (docs/architecture.md §5 step 2). The form is the source of
// truth, but it still enters the candidate set so reconciliation compares it with the
// transcript and photos. No model call.

/** The form contradicts its market profile; the message names field keys only, never values. */
export class FactFormError extends Error {
  override name = 'FactFormError';
  readonly missing: readonly string[];
  readonly invalid: readonly string[];

  constructor(missing: readonly string[], invalid: readonly string[]) {
    const parts = [
      missing.length > 0 ? `missing required field(s): ${missing.join(', ')}` : undefined,
      invalid.length > 0 ? `invalid value for field(s): ${invalid.join(', ')}` : undefined,
    ].filter((part) => part !== undefined);
    super(`The fact form does not match its market profile: ${parts.join('; ')}`);
    this.missing = missing;
    this.invalid = invalid;
  }
}

export interface FormCandidates {
  readonly candidates: FormCandidate[];
  /** Fields that are not market facts and not scalar values under a slug key (not stored). */
  readonly skippedFields: number;
}

const MAX_OTHER_TEXT = 300;

/**
 * Market facts first, in profile order, with the profile's unit and basis; `null` or absent
 * means unknown and yields no fact. Every required fact must be present and every value valid,
 * or the whole form is refused (`FactFormError`): the step must not silently drop the source
 * of truth.
 *
 * Other fields (street and place names until the base property fields exist) become `other:`
 * facts when their key is a slug and their value a number, boolean, or short text, in key order
 * (jsonb does not keep insertion order). Anything else is skipped and counted.
 */
export function factFormToCandidates(form: JsonObject, market: MarketProfile): FormCandidates {
  const candidates: FormCandidate[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const fact of market.facts) {
    const value = form[fact.key];
    if (value === undefined || value === null) {
      if (fact.required) missing.push(fact.key);
      continue;
    }
    if (!isValidProfileValue(fact, value)) {
      invalid.push(fact.key);
      continue;
    }
    candidates.push({
      key: fact.key,
      value,
      unit: profileUnit(market, fact),
      basis: fact.type === 'area' ? fact.basis : null,
      field: fact.key,
    });
  }
  if (missing.length > 0 || invalid.length > 0) throw new FactFormError(missing, invalid);

  const marketKeys = new Set(market.facts.map((fact) => fact.key));
  let skippedFields = 0;
  for (const field of Object.keys(form).sort()) {
    if (marketKeys.has(field)) continue;
    const value = form[field];
    if (value === null || value === undefined) continue;
    const scalar =
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_OTHER_TEXT);
    if (!OTHER_SLUG_PATTERN.test(field) || !scalar) {
      skippedFields += 1;
      continue;
    }
    candidates.push({
      key: `${OTHER_KEY_PREFIX}${field}`,
      value: typeof value === 'string' ? value.trim() : value,
      unit: null,
      basis: null,
      field,
    });
  }
  return { candidates, skippedFields };
}
