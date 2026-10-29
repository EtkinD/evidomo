import type {
  AreaUnit,
  FactFormField,
  MarketForm,
  ReadinessItem,
  RunStatus,
  VolumeUnit,
} from '@evidomo/shared';

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' });

export function languageName(code: string): string {
  return languageNames.of(code) ?? code;
}

export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'awaiting_gate':
      return 'Waiting for your review';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
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
      return 'badge-warning';
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

const AREA_UNIT_LABELS: Record<AreaUnit, string> = { m2: 'm²', sq_ft: 'sq ft' };
const VOLUME_UNIT_LABELS: Record<VolumeUnit, string> = { m3: 'm³', cu_ft: 'cu ft' };

export function areaUnitLabel(unit: AreaUnit): string {
  return AREA_UNIT_LABELS[unit];
}

export function volumeUnitLabel(unit: VolumeUnit): string {
  return VOLUME_UNIT_LABELS[unit];
}

/** `central_heating` -> `Central heating`. Enum values are slugs; the API takes them verbatim. */
export function humanize(value: string): string {
  const spaced = value.replaceAll('_', ' ').trim();
  return spaced === '' ? value : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One line describing what a field expects, shown under its label. */
export function fieldHint(field: FactFormField): string | null {
  switch (field.type) {
    case 'enum':
      return null;
    case 'area':
      return `In ${areaUnitLabel(field.unit)}. Basis: ${field.basis.label}.`;
    case 'volume':
      return `In ${volumeUnitLabel(field.unit)}.`;
    case 'money':
      return `In ${field.currency}.`;
    case 'integer': {
      if (field.min !== null && field.max !== null) {
        return `Whole number from ${field.min} to ${field.max}.`;
      }
      if (field.min !== null) return `Whole number, at least ${field.min}.`;
      if (field.max !== null) return `Whole number, at most ${field.max}.`;
      return 'Whole number.';
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
export function readinessMessage(item: ReadinessItem, market: MarketForm | undefined): string {
  switch (item.kind) {
    case 'photos':
      if (item.count < item.min) {
        return `Add at least ${item.min} ${item.min === 1 ? 'photo' : 'photos'} (${item.count} so far).`;
      }
      return `Remove ${item.count - item.max} ${item.count - item.max === 1 ? 'photo' : 'photos'} (at most ${item.max} allowed, ${item.count} so far).`;
    case 'voice_memo':
      return 'Record a voice walkthrough of the property.';
    case 'fact': {
      const label = market?.facts.find((fact) => fact.key === item.key)?.label ?? item.key;
      return item.problem === 'missing'
        ? `Fill in the required fact: ${label}.`
        : `Fix the value of ${label}: the saved value is no longer valid.`;
    }
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
}
