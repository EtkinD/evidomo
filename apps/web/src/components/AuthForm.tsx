import { PASSWORD_MIN_LENGTH, type AuthUserResponse } from '@evidomo/shared';
import type { UseMutationResult } from '@tanstack/react-query';
import Link from 'next/link';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  AUTH_FIELDS,
  describeAuthFailure,
  validateAuthForm,
  type AuthField,
  type AuthFormMode,
  type AuthFormValues,
  type FieldErrors,
} from '../lib/auth-form';

interface AuthFormProps {
  mode: AuthFormMode;
  mutation: UseMutationResult<AuthUserResponse, Error, AuthFormValues>;
  /** Login page URL that keeps the validated `next` path (used by the email-taken message). */
  loginHref: string;
}

const AUTOCOMPLETE = {
  login: 'current-password',
  register: 'new-password',
} as const satisfies Record<AuthFormMode, string>;

/**
 * Email and password form for login and registration. On success it does not navigate: the
 * mutation stores the user in the `me` cache and the page's `GuestOnly` guard redirects to `next`.
 */
export function AuthForm({ mode, mutation, loginHref }: AuthFormProps) {
  const t = useTranslations('auth');
  const id = useId();
  const ids = {
    email: `${id}-email`,
    emailError: `${id}-email-error`,
    password: `${id}-password`,
    passwordHint: `${id}-password-hint`,
    passwordError: `${id}-password-error`,
  };
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);

  const [values, setValues] = useState<AuthFormValues>({ email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [emailTaken, setEmailTaken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function focusFirstInvalid(fields: FieldErrors): void {
    const first = AUTH_FIELDS.find((field) => fields[field] !== undefined);
    if (first === 'email') emailInput.current?.focus();
    if (first === 'password') passwordInput.current?.focus();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (mutation.isPending) return;
    setFormError(null);
    setEmailTaken(false);

    const validation = validateAuthForm(t, mode, values);
    if (!validation.ok) {
      setFieldErrors(validation.fields);
      focusFirstInvalid(validation.fields);
      return;
    }
    setFieldErrors({});

    const submitted = values;
    mutation.mutate(validation.data, {
      onError: (error) => {
        const failure = describeAuthFailure(t, error, mode, submitted);
        switch (failure.kind) {
          case 'fields':
            setFieldErrors(failure.fields);
            focusFirstInvalid(failure.fields);
            break;
          case 'email_taken':
            setEmailTaken(true);
            emailInput.current?.focus();
            break;
          case 'message':
            setFormError(failure.message);
            break;
        }
      },
    });
  }

  function onChange(field: AuthField, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  const emailInvalid = fieldErrors.email !== undefined || emailTaken;
  const passwordInvalid = fieldErrors.password !== undefined;
  const passwordDescribedBy = [
    mode === 'register' ? ids.passwordHint : undefined,
    passwordInvalid ? ids.passwordError : undefined,
  ]
    .filter((value) => value !== undefined)
    .join(' ');

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      {formError !== null && (
        <div role="alert" className="alert alert-error">
          <span>{formError}</span>
        </div>
      )}

      <div className="fieldset">
        <label htmlFor={ids.email} className="fieldset-legend">
          {t('email')}
        </label>
        <input
          ref={emailInput}
          id={ids.email}
          name="email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={values.email}
          onChange={(event) => onChange('email', event.target.value)}
          aria-invalid={emailInvalid}
          aria-describedby={emailInvalid ? ids.emailError : undefined}
          className={`input min-h-11 w-full ${emailInvalid ? 'input-error' : ''}`}
        />
        {fieldErrors.email !== undefined && (
          <p id={ids.emailError} className="text-sm text-error">
            <span aria-hidden>× </span>
            {fieldErrors.email}
          </p>
        )}
        {fieldErrors.email === undefined && emailTaken && (
          <p id={ids.emailError} className="text-sm text-error">
            <span aria-hidden>× </span>
            {t('emailTaken')}{' '}
            <Link href={loginHref} className="link inline-flex min-h-11 items-center font-medium">
              {t('logInInstead')}
            </Link>
          </p>
        )}
      </div>

      <div className="fieldset">
        <label htmlFor={ids.password} className="fieldset-legend">
          {t('password')}
        </label>
        <input
          ref={passwordInput}
          id={ids.password}
          name="password"
          type="password"
          autoComplete={AUTOCOMPLETE[mode]}
          required
          value={values.password}
          onChange={(event) => onChange('password', event.target.value)}
          aria-invalid={passwordInvalid}
          aria-describedby={passwordDescribedBy === '' ? undefined : passwordDescribedBy}
          className={`input min-h-11 w-full ${passwordInvalid ? 'input-error' : ''}`}
        />
        {mode === 'register' && (
          <p id={ids.passwordHint} className="text-sm text-base-content/70">
            {t('passwordHint', { min: PASSWORD_MIN_LENGTH })}
          </p>
        )}
        {fieldErrors.password !== undefined && (
          <p id={ids.passwordError} className="text-sm text-error">
            <span aria-hidden>× </span>
            {fieldErrors.password}
          </p>
        )}
      </div>

      <button
        type="submit"
        className="btn btn-primary min-h-11 w-full"
        disabled={mutation.isPending}
      >
        {mutation.isPending && <span className="loading loading-spinner loading-sm" aria-hidden />}
        {mode === 'login' ? t('login.submit') : t('register.submit')}
      </button>
    </form>
  );
}
