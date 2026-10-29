import {
  FACT_FORM_LIMITS,
  type FactFormFieldProblem,
  type FactFormValue,
  type FactFormValues,
  type MarketFact,
  type MarketProfile,
} from '@evidomo/shared';
import { isValidProfileValue } from '../pipeline/extraction/normalize.ts';

// Saving the fact form (docs/architecture.md §8 "Project and input API"). Validity is decided by
// the fact extraction step's own rule (`isValidProfileValue`), so a saved form can never be
// refused by the run; this module only explains a refusal with a field problem code. Required
// fields are checked when a run starts, not on save, so drafts can be partial.

export type FactFormFieldProblems = Record<string, FactFormFieldProblem>;

export type FactFormCheck =
  | { readonly ok: true; readonly values: FactFormValues }
  | { readonly ok: false; readonly fields: FactFormFieldProblems };

function profileProblem(fact: MarketFact, value: FactFormValue): FactFormFieldProblem | undefined {
  if (isValidProfileValue(fact, value)) return undefined;
  switch (fact.type) {
    case 'enum':
      return typeof value === 'string' ? 'not_allowed' : 'wrong_type';
    case 'area':
    case 'volume':
    case 'money':
      return typeof value === 'number' ? 'out_of_range' : 'wrong_type';
    case 'integer':
      if (typeof value !== 'number') return 'wrong_type';
      return Number.isSafeInteger(value) ? 'out_of_range' : 'not_an_integer';
    case 'boolean':
      return 'wrong_type';
  }
}

function extraProblem(key: string, value: FactFormValue): FactFormFieldProblem | undefined {
  if (!FACT_FORM_LIMITS.extraKeyPattern.test(key)) return 'invalid_key';
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.length === 0 || value.length > FACT_FORM_LIMITS.extraTextMaxLength) {
      return 'invalid_text';
    }
  }
  return undefined;
}

/**
 * Validates a submitted form against the market profile. `null` clears a field. Extra fields
 * (keys outside the profile) are stored trimmed; the run turns them into `other:<key>` facts.
 */
export function checkFactForm(
  submitted: Readonly<Record<string, FactFormValue | null>>,
  market: MarketProfile,
): FactFormCheck {
  const facts = new Map(market.facts.map((fact) => [fact.key, fact]));
  const values: FactFormValues = {};
  const fields: FactFormFieldProblems = {};
  let extraCount = 0;
  // Key order, so the extra-field limit picks the same keys every time.
  for (const key of Object.keys(submitted).sort()) {
    const value = submitted[key];
    if (value === null || value === undefined) continue;
    const fact = facts.get(key);
    if (fact !== undefined) {
      const problem = profileProblem(fact, value);
      if (problem === undefined) values[key] = value;
      else fields[key] = problem;
      continue;
    }
    const problem = extraProblem(key, value);
    if (problem !== undefined) {
      fields[key] = problem;
      continue;
    }
    extraCount += 1;
    if (extraCount > FACT_FORM_LIMITS.maxExtraFields) {
      fields[key] = 'too_many_fields';
      continue;
    }
    values[key] = typeof value === 'string' ? value.trim() : value;
  }
  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, values };
}

const FIELD_PROBLEM_MESSAGES: Readonly<Record<FactFormFieldProblem, string>> = {
  wrong_type: 'Wrong value type for this field',
  not_an_integer: 'Expected a whole number',
  out_of_range: 'Value is out of range',
  not_allowed: 'Not one of the allowed values',
  invalid_key: 'Field names must be lowercase snake_case',
  invalid_text: `Text must be 1-${FACT_FORM_LIMITS.extraTextMaxLength} characters`,
  too_many_fields: `At most ${FACT_FORM_LIMITS.maxExtraFields} extra fields`,
};

/** `validation_failed` issues for the field problems (path `['values', key]`). */
export function fieldIssues(
  fields: FactFormFieldProblems,
): { path: (string | number)[]; message: string }[] {
  return Object.entries(fields).map(([key, problem]) => ({
    path: ['values', key],
    message: FIELD_PROBLEM_MESSAGES[problem],
  }));
}
