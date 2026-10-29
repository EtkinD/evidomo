import {
  loginRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  registerRequestSchema,
} from '@evidomo/shared';
import { ApiRequestError } from './api';

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
export function fieldMessage(field: AuthField, mode: AuthFormMode, values: AuthFormValues): string {
  if (field === 'email') {
    return values.email.trim() === ''
      ? 'Enter your email address.'
      : 'Enter a valid email address, such as name@example.com.';
  }
  const { password } = values;
  if (password === '') return mode === 'login' ? 'Enter your password.' : 'Enter a password.';
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (mode === 'register' && password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  // The server counts characters after Unicode normalization, so a borderline value can pass
  // here and still be refused there.
  return mode === 'register'
    ? `Use ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`
    : 'Enter your password.';
}

export type AuthFormValidation =
  // `data` is normalized by the schema (trimmed, lower-cased email) and is what gets sent.
  { ok: true; data: AuthFormValues } | { ok: false; fields: FieldErrors };

/** Client-side validation with the same shared schema the API applies. */
export function validateAuthForm(mode: AuthFormMode, values: AuthFormValues): AuthFormValidation {
  const schema = mode === 'login' ? loginRequestSchema : registerRequestSchema;
  const result = schema.safeParse(values);
  if (result.success) return { ok: true, data: result.data };

  const fields: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (isAuthField(field) && fields[field] === undefined) {
      fields[field] = fieldMessage(field, mode, values);
    }
  }
  return { ok: false, fields };
}

function formatWait(seconds: number): string {
  if (seconds <= 60) {
    const whole = Math.max(1, seconds);
    return `${whole} ${whole === 1 ? 'second' : 'seconds'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

const GENERIC_FAILURE = 'Something went wrong on our side. Try again in a moment.';

/** Maps a failed login or registration request to what the form shows. */
export function describeAuthFailure(
  error: unknown,
  mode: AuthFormMode,
  values: AuthFormValues,
): AuthFormFailure {
  // fetch rejects with a TypeError when the request never got a response.
  if (error instanceof TypeError) {
    return {
      kind: 'message',
      message: 'Could not reach Evidomo. Check your connection and try again.',
    };
  }
  if (!(error instanceof ApiRequestError)) return { kind: 'message', message: GENERIC_FAILURE };

  switch (error.code) {
    case 'validation_failed': {
      const fields: FieldErrors = {};
      for (const issue of error.issues) {
        const field = issue.path[0];
        if (isAuthField(field) && fields[field] === undefined) {
          fields[field] = fieldMessage(field, mode, values);
        }
      }
      return Object.keys(fields).length > 0
        ? { kind: 'fields', fields }
        : { kind: 'message', message: 'Check the form and try again.' };
    }
    case 'invalid_credentials':
      return { kind: 'message', message: 'Email or password is incorrect.' };
    case 'email_taken':
      return { kind: 'email_taken' };
    case 'rate_limited':
      return {
        kind: 'message',
        message:
          error.retryAfterSeconds === null
            ? 'Too many attempts. Wait a few minutes and try again.'
            : `Too many attempts. Try again in ${formatWait(error.retryAfterSeconds)}.`,
      };
    case 'forbidden_origin':
      return {
        kind: 'message',
        message:
          'The request was blocked because it did not come from this site. Reload the page and try again.',
      };
    case 'invalid_json':
    case 'unsupported_media_type':
    case 'payload_too_large':
      return {
        kind: 'message',
        message: 'The form could not be sent. Reload the page and try again.',
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
    case 'daily_budget_reached':
    case null:
      return { kind: 'message', message: GENERIC_FAILURE };
    default: {
      const unreachable: never = error.code;
      return unreachable;
    }
  }
}
