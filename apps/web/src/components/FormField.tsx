import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';

export interface ControlProps {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
}

interface FieldProps {
  id: string;
  label: string;
  required?: boolean;
  hint?: string | null | undefined;
  error?: string | undefined;
  children: (control: ControlProps) => ReactNode;
}

/** daisyUI fieldset recipe: label, control, helper text, and an error tied by `aria-describedby`. */
export function Field({ id, label, required = false, hint, error, children }: FieldProps) {
  const t = useTranslations('common');
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasHint = hint !== null && hint !== undefined && hint !== '';
  const describedBy = [hasHint ? hintId : undefined, error === undefined ? undefined : errorId]
    .filter((value) => value !== undefined)
    .join(' ');

  return (
    <div className="fieldset">
      <label htmlFor={id} className="fieldset-legend">
        {label}
        {required && <span className="font-normal text-base-content/70"> ({t('required')})</span>}
      </label>
      {children({
        id,
        'aria-invalid': error !== undefined,
        'aria-describedby': describedBy === '' ? undefined : describedBy,
      })}
      {hasHint && (
        <p id={hintId} className="text-sm text-base-content/70">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className="text-sm text-error">
          {/* A glyph beside the colour, so the error is not conveyed by red alone. */}
          <span aria-hidden>× </span>
          {error}
        </p>
      )}
    </div>
  );
}
