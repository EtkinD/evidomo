import {
  displayUnit,
  type AreaUnit,
  type FactFormField,
  type MarketForm,
  type ReadinessItem,
  type RunStatus,
  type VolumeUnit,
} from '@evidomo/shared';
import type { Translator } from './i18n';

/** A language's name in the interface language (`de` becomes "German", "Almanca", ...). */
export function languageName(code: string, locale: string): string {
  return new Intl.DisplayNames([locale], { type: 'language', fallback: 'code' }).of(code) ?? code;
}

export function runStatusLabel(t: Translator<'status'>, status: RunStatus): string {
  return t(status);
}

/** daisyUI badge modifier for a run status; the label always carries the meaning too. */
export function runStatusBadge(status: RunStatus): string {
  switch (status) {
    case 'completed':
      return 'badge-success';
    case 'failed':
      return 'badge-error';
    case 'running':
    case 'queued':
      return 'badge-info';
    case 'awaiting_gate':
      return 'badge-secondary';
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

// The unit text is shared with the review screens and the exported pack (`displayUnit`).
export function areaUnitLabel(unit: AreaUnit): string {
  return displayUnit(unit);
}

export function volumeUnitLabel(unit: VolumeUnit): string {
  return displayUnit(unit);
}

/** `central_heating` -> `Central heating`. Enum values are slugs; the API takes them verbatim. */
export function humanize(value: string): string {
  const spaced = value.replaceAll('_', ' ').trim();
  return spaced === '' ? value : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * One line describing what a field expects, shown under its label. The basis label of an area
 * field comes from the market profile and is shown as the profile wrote it.
 */
export function fieldHint(t: Translator<'factForm'>, field: FactFormField): string | null {
  switch (field.type) {
    case 'enum':
      return null;
    case 'area':
      return t('hints.area', { unit: areaUnitLabel(field.unit), basis: field.basis.label });
    case 'volume':
      return t('hints.volume', { unit: volumeUnitLabel(field.unit) });
    case 'money':
      return t('hints.money', { currency: field.currency });
    case 'integer': {
      if (field.min !== null && field.max !== null) {
        return t('hints.integerRange', { min: field.min, max: field.max });
      }
      if (field.min !== null) return t('hints.integerMin', { min: field.min });
      if (field.max !== null) return t('hints.integerMax', { max: field.max });
      return t('hints.integer');
    }
    case 'boolean':
      return null;
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
}

/** The sentence for one readiness item; fact labels come from the market form when loaded. */
export function readinessMessage(
  t: Translator<'readiness'>,
  item: ReadinessItem,
  market: MarketForm | undefined,
): string {
  switch (item.kind) {
    case 'photos':
      if (item.count < item.min) {
        return t('addPhotos', { min: item.min, count: item.count });
      }
      return t('removePhotos', { extra: item.count - item.max, max: item.max, count: item.count });
    case 'voice_memo':
      return t('recordVoice');
    case 'fact': {
      const label = market?.facts.find((fact) => fact.key === item.key)?.label ?? item.key;
      return item.problem === 'missing' ? t('factMissing', { label }) : t('factInvalid', { label });
    }
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
}
