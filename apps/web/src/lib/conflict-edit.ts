import type {
  FactConflictDecisionRequest,
  FactFormField,
  GateConflict,
  MarketForm,
} from '@evidomo/shared';
import { checkFact, factProblemMessage, parseNumberText } from './fact-form';
import type { Translator } from './i18n';

/** Longest text the API accepts for an edited value. */
export const MAX_EDIT_TEXT = 300;

/**
 * What the "Enter a value" control asks for. A market key follows its fact type (the same rules
 * as the fact form); an `other:` key has no declared type, so it follows the values in conflict
 * (text when they are of mixed types).
 */
export type EditControl =
  | { kind: 'market'; field: FactFormField }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'text' };

export function editControlFor(
  conflict: GateConflict,
  market: MarketForm | undefined,
): EditControl {
  const field = market?.facts.find((fact) => fact.key === conflict.key);
  if (field !== undefined) return { kind: 'market', field };
  const types = new Set(conflict.sides.map((side) => typeof side.value));
  if (types.size === 1) {
    if (types.has('number')) return { kind: 'number' };
    if (types.has('boolean')) return { kind: 'boolean' };
  }
  return { kind: 'text' };
}

type Pick = 'unit' | 'basis';
type Picks = { [K in Pick]?: string | undefined };

/** The unit or basis every side agrees on (null: all sides have none, or they disagree). */
export function sharedMeasure(conflict: GateConflict, pick: Pick): string | null {
  const first = conflict.sides[0]?.[pick] ?? null;
  return conflict.sides.every((side) => side[pick] === first) ? first : null;
}

/**
 * For an `other:` key whose sides disagree on the unit or basis: the values to choose from, with
 * `''` standing for none. Null when the profile fixes them or the sides agree.
 */
export function measureOptions(
  conflict: GateConflict,
  control: EditControl,
  pick: Pick,
): string[] | null {
  if (control.kind === 'market') return null;
  const values = conflict.sides.map((side) => side[pick] ?? '');
  const distinct = [...new Set(values)];
  return distinct.length > 1 ? distinct : null;
}

/** The unit and basis the edited value will carry, as the request sends them. */
export function editedMeasure(
  conflict: GateConflict,
  control: EditControl,
  picks: Picks,
): { unit: string | null; basis: string | null } {
  if (control.kind === 'market') return { unit: null, basis: null };
  const resolve = (pick: Pick): string | null =>
    measureOptions(conflict, control, pick) === null
      ? sharedMeasure(conflict, pick)
      : picks[pick] || null;
  return { unit: resolve('unit'), basis: resolve('basis') };
}

export type EditResult =
  | { ok: true; body: Extract<FactConflictDecisionRequest, { choice: 'edit' }> }
  | { ok: false; message: string };

/** Turns what was typed into the request, or says what is wrong with it. */
export function buildEditRequest(
  t: Translator<'factForm'>,
  control: EditControl,
  conflict: GateConflict,
  text: string,
  picks: Picks = {},
): EditResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: t('edit.enterValue') };

  if (control.kind === 'market') {
    const { field } = control;
    const problem = checkFact(field, trimmed);
    if (problem !== null) return { ok: false, message: factProblemMessage(t, field, problem) };
    // The profile fixes unit and basis for its own keys, so they are not sent.
    switch (field.type) {
      case 'enum':
        return { ok: true, body: { choice: 'edit', value: trimmed } };
      case 'boolean':
        return { ok: true, body: { choice: 'edit', value: trimmed === 'yes' } };
      default: {
        const number = parseNumberText(trimmed);
        return number === null
          ? { ok: false, message: factProblemMessage(t, field, 'wrong_type') }
          : { ok: true, body: { choice: 'edit', value: number } };
      }
    }
  }

  for (const pick of ['unit', 'basis'] as const) {
    if (measureOptions(conflict, control, pick) !== null && picks[pick] === undefined) {
      return {
        ok: false,
        message: pick === 'unit' ? t('edit.chooseUnit') : t('edit.chooseBasis'),
      };
    }
  }
  const { unit, basis } = editedMeasure(conflict, control, picks);
  const measure = { ...(unit === null ? {} : { unit }), ...(basis === null ? {} : { basis }) };
  switch (control.kind) {
    case 'number': {
      const number = parseNumberText(trimmed);
      return number === null
        ? {
            ok: false,
            message: t('problems.enterNumber'),
          }
        : { ok: true, body: { choice: 'edit', value: number, ...measure } };
    }
    case 'boolean':
      return trimmed === 'yes' || trimmed === 'no'
        ? { ok: true, body: { choice: 'edit', value: trimmed === 'yes', ...measure } }
        : { ok: false, message: t('edit.chooseYesNo') };
    case 'text':
      return trimmed.length > MAX_EDIT_TEXT
        ? { ok: false, message: t('edit.tooLong', { max: MAX_EDIT_TEXT }) }
        : { ok: true, body: { choice: 'edit', value: trimmed, ...measure } };
  }
}
