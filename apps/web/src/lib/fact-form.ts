import type {
  FactFormField,
  FactFormFieldProblem,
  FactFormValue,
  FactFormValues,
} from '@evidomo/shared';
import type { Translator } from './i18n';
import { humanize } from './project-view';

type FactT = Translator<'factForm'>;

/**
 * Text per field key, exactly what the controls hold: '' is unknown, booleans are 'yes' / 'no',
 * numbers stay as typed until they are validated.
 */
export type FactDraft = Record<string, string>;

export function draftFromValues(
  fields: readonly FactFormField[],
  values: FactFormValues,
): FactDraft {
  const draft: FactDraft = {};
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined) {
      draft[field.key] = '';
    } else if (typeof value === 'boolean') {
      draft[field.key] = value ? 'yes' : 'no';
    } else {
      draft[field.key] = String(value);
    }
  }
  return draft;
}

const NUMBER_TEXT = /^(-?)(\d+)(?:[.,](\d+))?$/;

/**
 * Parses what a person types into a number input. Exactly one comma or point is the decimal
 * separator ("92,5" and "92.5" are the same); anything else is rejected rather than guessed at,
 * so unparsable text is never read as "empty" and a stored value is never erased by accident.
 * A group of exactly three digits after the separator ("1,000", "1.250") is ambiguous with a
 * thousands separator, so it is refused too unless the integer part is 0.
 */
export function parseNumberText(text: string): number | null {
  const match = NUMBER_TEXT.exec(text.trim());
  if (match === null) return null;
  const [, sign = '', whole = '', fraction] = match;
  if (fraction?.length === 3 && whole !== '0') return null;
  const number = Number(`${sign}${whole}${fraction === undefined ? '' : `.${fraction}`}`);
  return Number.isFinite(number) ? number : null;
}

/** Same rules as the server (`factFormFieldSchema` documents them); null means valid or empty. */
export function checkFact(field: FactFormField, text: string): FactFormFieldProblem | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  switch (field.type) {
    case 'enum':
      return field.values.includes(text) ? null : 'not_allowed';
    case 'boolean':
      return trimmed === 'yes' || trimmed === 'no' ? null : 'wrong_type';
    case 'area':
    case 'volume':
    case 'money': {
      const number = parseNumberText(trimmed);
      if (number === null) return 'wrong_type';
      return number < 0 ? 'out_of_range' : null;
    }
    case 'integer': {
      const number = parseNumberText(trimmed);
      if (number === null) return 'wrong_type';
      if (!Number.isSafeInteger(number)) return 'not_an_integer';
      if (
        (field.min !== null && number < field.min) ||
        (field.max !== null && number > field.max)
      ) {
        return 'out_of_range';
      }
      return null;
    }
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
}

/** The message under a field, for a problem found here or reported by the server. */
export function factProblemMessage(
  t: FactT,
  field: FactFormField,
  problem: FactFormFieldProblem,
): string {
  switch (problem) {
    case 'wrong_type':
      return field.type === 'boolean'
        ? t('problems.chooseYesNo')
        : field.type === 'enum'
          ? t('problems.chooseListed')
          : t('problems.enterNumber');
    case 'not_an_integer':
      return t('problems.wholeNumber');
    case 'out_of_range':
      if (field.type === 'integer') {
        if (field.min !== null && field.max !== null) {
          return t('problems.rangeBoth', { min: field.min, max: field.max });
        }
        if (field.min !== null) return t('problems.rangeMin', { min: field.min });
        if (field.max !== null) return t('problems.rangeMax', { max: field.max });
      }
      return t('problems.nonNegative');
    case 'not_allowed':
      return field.type === 'enum'
        ? t('problems.chooseOneOf', { options: field.values.map(humanize).join(', ') })
        : t('problems.notAllowed');
    case 'invalid_key':
    case 'invalid_text':
    case 'too_many_fields':
      return t('problems.refused');
    default: {
      const unreachable: never = problem;
      return unreachable;
    }
  }
}

export function validateDraft(
  t: FactT,
  fields: readonly FactFormField[],
  draft: FactDraft,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const problem = checkFact(field, draft[field.key] ?? '');
    if (problem !== null) errors[field.key] = factProblemMessage(t, field, problem);
  }
  return errors;
}

function toValue(field: FactFormField, text: string): FactFormValue | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  switch (field.type) {
    case 'enum':
      return text;
    case 'boolean':
      return trimmed === 'yes';
    case 'area':
    case 'volume':
    case 'money':
    case 'integer': {
      const number = parseNumberText(trimmed);
      // validateDraft runs first; reaching this with unparsable text would erase the stored
      // value, so fail loudly instead of sending null.
      if (number === null) throw new Error(`Unparsable value for ${field.key}`);
      return number;
    }
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
}

/**
 * The full form for `PUT`. Keys outside the market profile ("extra fields", e.g. `street_name`)
 * have no controls here; they are carried over unchanged because the PUT clears every key it
 * does not send.
 */
export function payloadFromDraft(
  fields: readonly FactFormField[],
  draft: FactDraft,
  stored: FactFormValues,
): Record<string, FactFormValue | null> {
  const profileKeys = new Set(fields.map((field) => field.key));
  const values: Record<string, FactFormValue | null> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!profileKeys.has(key)) values[key] = value;
  }
  for (const field of fields) values[field.key] = toValue(field, draft[field.key] ?? '');
  return values;
}

export function extraFieldCount(fields: readonly FactFormField[], stored: FactFormValues): number {
  const profileKeys = new Set(fields.map((field) => field.key));
  return Object.keys(stored).filter((key) => !profileKeys.has(key)).length;
}

export function sameDraft(a: FactDraft, b: FactDraft): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => (a[key] ?? '').trim() === (b[key] ?? '').trim());
}
