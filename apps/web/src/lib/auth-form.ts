import {
  loginRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  registerRequestSchema,
} from '@evidomo/shared';
import { ApiRequestError } from './api';
import type { Translator } from './i18n';

type AuthT = Translator<'auth'>;

export type AuthFormMode = 'login' | 'register';
export type AuthField = 'email' | 'password';
export const AUTH_FIELDS: readonly AuthField[] = ['email', 'password'];

export interface AuthFormValues {
  email: string;
  password: string;
}

export type FieldErrors = Partial<Record<AuthField, string>>;

/** How a failed submission is shown. */
export type AuthFormFailure =
  | { kind: 'fields'; fields: FieldErrors }
  // Rendered next to the email field with a link to the login page.
  | { kind: 'email_taken' }
  | { kind: 'message'; message: string };

function isAuthField(value: unknown): value is AuthField {
  return value === 'email' || value === 'password';
}

/**
 * A human message for an invalid field. The schemas decide *whether* a field is valid; the
 * message is derived from the submitted value so client and server failures read the same.
 */
export function fieldMessage(
  t: AuthT,
  field: AuthField,
  mode: AuthFormMode,
  values: AuthFormValues,
): string {
  if (field === 'email') {
    return values.email.trim() === '' ? t('errors.emailEmpty') : t('errors.emailInvalid');
  }
  const { password } = values;
  if (password === '')
    return mode === 'login' ? t('errors.passwordEmptyLogin') : t('errors.passwordEmpty');
  if (password.length > PASSWORD_MAX_LENGTH) {
    return t('errors.passwordTooLong', { max: PASSWORD_MAX_LENGTH });
  }
  if (mode === 'register' && password.length < PASSWORD_MIN_LENGTH) {
    return t('errors.passwordTooShort', { min: PASSWORD_MIN_LENGTH });
  }
  // The server counts characters after Unicode normalization, so a borderline value can pass
  // here and still be refused there.
  return mode === 'register'
    ? t('errors.passwordRange', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })
    : t('errors.passwordEmptyLogin');
}

export type AuthFormValidation =
  // `data` is normalized by the schema (trimmed, lower-cased email) and is what gets sent.
  { ok: true; data: AuthFormValues } | { ok: false; fields: FieldErrors };

/** Client-side validation with the same shared schema the API applies. */
export function validateAuthForm(
  t: AuthT,
  mode: AuthFormMode,
  values: AuthFormValues,
): AuthFormValidation {
  const schema = mode === 'login' ? loginRequestSchema : registerRequestSchema;
  const result = schema.safeParse(values);
  if (result.success) return { ok: true, data: result.data };

  const fields: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (isAuthField(field) && fields[field] === undefined) {
      fields[field] = fieldMessage(t, field, mode, values);
    }
  }
  return { ok: false, fields };
}

/** Maps a failed login or registration request to what the form shows. */
export function describeAuthFailure(
  t: AuthT,
  error: unknown,
  mode: AuthFormMode,
  values: AuthFormValues,
): AuthFormFailure {
  // fetch rejects with a TypeError when the request never got a response.
  if (error instanceof TypeError) {
    return {
      kind: 'message',
      message: t('errors.unreachable'),
    };
  }
  if (!(error instanceof ApiRequestError)) return { kind: 'message', message: t('errors.generic') };

  switch (error.code) {
    case 'validation_failed': {
      const fields: FieldErrors = {};
      for (const issue of error.issues) {
        const field = issue.path[0];
        if (isAuthField(field) && fields[field] === undefined) {
          fields[field] = fieldMessage(t, field, mode, values);
        }
      }
      return Object.keys(fields).length > 0
        ? { kind: 'fields', fields }
        : { kind: 'message', message: t('errors.checkForm') };
    }
    case 'invalid_credentials':
      return { kind: 'message', message: t('errors.invalidCredentials') };
    case 'email_taken':
      return { kind: 'email_taken' };
    case 'rate_limited':
      return {
        kind: 'message',
        message:
          error.retryAfterSeconds === null
            ? t('errors.rateLimited')
            : error.retryAfterSeconds <= 60
              ? t('errors.rateLimitedSeconds', { count: Math.max(1, error.retryAfterSeconds) })
              : t('errors.rateLimitedMinutes', { count: Math.ceil(error.retryAfterSeconds / 60) }),
      };
    case 'forbidden_origin':
      return {
        kind: 'message',
        message: t('errors.forbiddenOrigin'),
      };
    case 'invalid_json':
    case 'unsupported_media_type':
    case 'payload_too_large':
      return {
        kind: 'message',
        message: t('errors.notSent'),
      };
    // Gate, run API, and project codes are never returned by the auth endpoints.
    case 'unauthenticated':
    case 'internal_error':
    case 'not_found':
    case 'gate_not_open':
    case 'fact_not_in_conflict':
    case 'gate_decisions_pending':
    case 'claim_edit_rejected':
    case 'export_not_ready':
    case 'range_not_satisfiable':
    case 'too_many_streams':
    case 'inputs_locked':
    case 'photo_limit_reached':
    case 'too_many_uploads':
    case 'upload_rejected':
    case 'not_ready':
    case 'run_active':
    case 'run_in_progress':
    case 'daily_budget_reached':
    case 'access_code_invalid':
    case 'run_limit_reached':
    case 'run_not_resumable':
    case 'run_budget_exhausted':
    case null:
      return { kind: 'message', message: t('errors.generic') };
    default: {
      const unreachable: never = error.code;
      return unreachable;
    }
  }
}
