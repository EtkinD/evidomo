import {
  createProjectRequestSchema,
  updateProjectRequestSchema,
  type CreateProjectRequest,
  type OfficeProfile,
  type UpdateProjectRequest,
} from '@evidomo/shared';
import { ApiRequestError } from './api';
import type { Translator } from './i18n';
import { describeRequestFailure } from './request-failure';

type FormT = Translator<'projectForm'>;

export interface OfficeProfileValues {
  agencyName: string;
  contactBlock: string;
  tone: string;
}

export type OfficeProfileField = keyof OfficeProfileValues;

export const PROJECT_FORM_FIELDS = [
  'title',
  'agencyName',
  'contactBlock',
  'tone',
  'market',
  'outputLanguage',
] as const;
export type ProjectFormField = (typeof PROJECT_FORM_FIELDS)[number];
export type ProjectFormErrors = Partial<Record<ProjectFormField, string>>;

export interface CreateProjectValues extends OfficeProfileValues {
  title: string;
  /** `id@version`, or '' before the market list has loaded. */
  market: string;
  outputLanguage: string;
}

export function emptyOfficeProfile(): OfficeProfileValues {
  return { agencyName: '', contactBlock: '', tone: '' };
}

export function officeProfileToValues(profile: OfficeProfile): OfficeProfileValues {
  return {
    agencyName: profile.agencyName,
    contactBlock: profile.contactBlock ?? '',
    tone: profile.tone ?? '',
  };
}

/** Blank optional fields are omitted: the API stores no empty strings. */
export function officeProfilePayload(values: OfficeProfileValues): OfficeProfile {
  const profile: OfficeProfile = { agencyName: values.agencyName.trim() };
  if (values.contactBlock.trim() !== '') profile.contactBlock = values.contactBlock.trim();
  if (values.tone.trim() !== '') profile.tone = values.tone.trim();
  return profile;
}

export function sameOfficeProfile(a: OfficeProfileValues, b: OfficeProfileValues): boolean {
  const left = officeProfilePayload(a);
  const right = officeProfilePayload(b);
  return (
    left.agencyName === right.agencyName &&
    left.contactBlock === right.contactBlock &&
    left.tone === right.tone
  );
}

export function marketValue(ref: { id: string; version: number }): string {
  return `${ref.id}@${ref.version}`;
}

function parseMarketValue(value: string): { id: string; version: number } | null {
  const at = value.lastIndexOf('@');
  if (at < 1) return null;
  const version = Number(value.slice(at + 1));
  return Number.isSafeInteger(version) ? { id: value.slice(0, at), version } : null;
}

function isProjectFormField(value: unknown): value is ProjectFormField {
  return PROJECT_FORM_FIELDS.some((field) => field === value);
}

/** Maps an issue path (`['officeProfile', 'agencyName']`) to the form field that owns it. */
function fieldForPath(path: readonly PropertyKey[]): ProjectFormField | null {
  const [head, second] = path;
  const candidate = head === 'officeProfile' ? second : head;
  return isProjectFormField(candidate) ? candidate : null;
}

/**
 * The schemas decide whether a field is valid; the message is derived from the field and the
 * submitted value so client and server failures read the same.
 */
export function projectFieldMessage(
  t: FormT,
  field: ProjectFormField,
  values: CreateProjectValues,
): string {
  switch (field) {
    case 'title':
      return values.title.trim() === ''
        ? t('errors.titleEmpty')
        : t('errors.titleTooLong', { max: 200 });
    case 'agencyName':
      return values.agencyName.trim() === ''
        ? t('errors.agencyEmpty')
        : t('errors.agencyTooLong', { max: 200 });
    case 'contactBlock':
      return t('errors.contactTooLong', { max: 2000 });
    case 'tone':
      return t('errors.toneTooLong', { max: 200 });
    case 'market':
      return t('errors.marketRequired');
    case 'outputLanguage':
      return t('errors.languageRequired');
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
}

export type CreateValidation =
  { ok: true; data: CreateProjectRequest } | { ok: false; errors: ProjectFormErrors };

export function validateCreateProject(t: FormT, values: CreateProjectValues): CreateValidation {
  const market = parseMarketValue(values.market);
  const result = createProjectRequestSchema.safeParse({
    title: values.title,
    officeProfile: officeProfilePayload(values),
    market: market ?? { id: '', version: 0 },
    outputLanguage: values.outputLanguage,
  });
  if (result.success) {
    return {
      ok: true,
      data: {
        title: result.data.title,
        officeProfile: result.data.officeProfile,
        market: result.data.market,
        outputLanguage: result.data.outputLanguage,
      },
    };
  }
  const errors: ProjectFormErrors = {};
  for (const issue of result.error.issues) {
    const field = fieldForPath(issue.path);
    if (field !== null && errors[field] === undefined) {
      errors[field] = projectFieldMessage(t, field, values);
    }
  }
  return { ok: false, errors };
}

export type DetailsValidation =
  { ok: true; data: UpdateProjectRequest } | { ok: false; errors: ProjectFormErrors };

/** Validates the details form; `officeProfile` is sent only when it is editable and changed. */
export function validateProjectDetails(
  t: FormT,
  values: CreateProjectValues,
  include: { title: boolean; officeProfile: boolean },
): DetailsValidation {
  const body: UpdateProjectRequest = {};
  if (include.title) body.title = values.title;
  if (include.officeProfile) body.officeProfile = officeProfilePayload(values);
  const result = updateProjectRequestSchema.safeParse(body);
  if (result.success) return { ok: true, data: body };
  const errors: ProjectFormErrors = {};
  for (const issue of result.error.issues) {
    const field = fieldForPath(issue.path);
    if (field !== null && errors[field] === undefined) {
      errors[field] = projectFieldMessage(t, field, values);
    }
  }
  return { ok: false, errors };
}

export type ProjectFormFailure =
  { kind: 'fields'; errors: ProjectFormErrors } | { kind: 'message'; message: string };

/** Maps a failed create or update request to field errors or one form-level message. */
export function describeProjectFailure(
  t: FormT,
  tApi: Translator<'apiErrors'>,
  error: unknown,
  values: CreateProjectValues,
): ProjectFormFailure {
  if (error instanceof ApiRequestError && error.code === 'validation_failed') {
    const errors: ProjectFormErrors = {};
    for (const issue of error.issues) {
      const field = fieldForPath(issue.path);
      if (field !== null && errors[field] === undefined) {
        errors[field] = projectFieldMessage(t, field, values);
      }
    }
    return Object.keys(errors).length > 0
      ? { kind: 'fields', errors }
      : { kind: 'message', message: t('errors.checkForm') };
  }
  return { kind: 'message', message: describeRequestFailure(tApi, error) };
}
