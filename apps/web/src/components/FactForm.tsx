import type { FactFormField, MarketForm, ProjectDetailResponse } from '@evidomo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { ApiRequestError } from '../lib/api';
import {
  draftFromValues,
  extraFieldCount,
  factProblemMessage,
  payloadFromDraft,
  sameDraft,
  validateDraft,
  type FactDraft,
} from '../lib/fact-form';
import { projectKey, useSaveFactForm } from '../lib/projects';
import { describeRequestFailure } from '../lib/request-failure';
import { fieldHint, fieldLabel, optionLabel } from '../lib/project-view';
import { Field } from './FormField';

interface FactFormProps {
  projectId: string;
  market: MarketForm;
  values: ProjectDetailResponse['factForm']['values'];
  /** Inputs are fixed by a run: the form shows the saved values and cannot be edited. */
  locked: boolean;
  /** True while there are edits that are not saved (or that conflict with newer saved values). */
  onUnsavedChange?: (unsaved: boolean) => void;
}

/** What the user has typed, and the saved values it started from. */
interface Editing {
  draft: FactDraft;
  base: FactDraft;
}

function BooleanField({
  field,
  id,
  value,
  error,
  disabled,
  onChange,
}: {
  field: FactFormField;
  id: string;
  value: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  const t = useTranslations('factForm');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const options = [
    { value: 'yes', label: t('yes') },
    { value: 'no', label: t('no') },
    { value: '', label: t('unknown') },
  ];
  return (
    <fieldset className="fieldset" aria-describedby={error === undefined ? undefined : errorId}>
      <legend className="fieldset-legend">
        {fieldLabel(field, locale)}
        {field.required && (
          <span className="font-normal text-base-content/70"> ({tCommon('required')})</span>
        )}
      </legend>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {options.map((option, index) => (
          <label key={option.value} className="flex min-h-11 min-w-11 items-center gap-2">
            <input
              // The first radio carries the field id so a failed save can move focus to the group.
              id={index === 0 ? id : undefined}
              type="radio"
              name={id}
              className="radio radio-sm"
              disabled={disabled}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {error !== undefined && (
        <p id={errorId} className="text-sm text-error">
          <span aria-hidden>× </span>
          {error}
        </p>
      )}
    </fieldset>
  );
}

function idFor(field: FactFormField): string {
  return `fact-${field.key}`;
}

/**
 * The fact form, generated from the market profile: one control per fact, in profile order.
 * The saved form is the whole PUT body, so every control is sent on save and an emptied control
 * clears its fact.
 *
 * The saved values (props) are the source of truth. Edits live in `editing`, which remembers the
 * saved values it started from: if those change underneath (another tab saved, a refetch), an
 * untouched form simply shows the new values, and an edited one asks before discarding.
 */
export function FactForm({ projectId, market, values, locked, onUnsavedChange }: FactFormProps) {
  const t = useTranslations('factForm');
  const tApi = useTranslations('apiErrors');
  const locale = useLocale();
  const queryClient = useQueryClient();
  const mutation = useSaveFactForm(projectId);
  const saving = useRef(false);
  const baseline = draftFromValues(market.facts, values);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ key: string; n: number } | null>(null);

  const edited =
    !locked &&
    editing !== null &&
    !sameDraft(editing.draft, baseline) &&
    !sameDraft(editing.draft, editing.base);
  const conflict = edited && editing !== null && !sameDraft(editing.base, baseline);
  const unsaved = edited;
  const draft = edited && editing !== null ? editing.draft : baseline;
  const readOnly = locked || mutation.isPending;
  const extras = extraFieldCount(market.facts, values);

  useEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange?.(false), [onUnsavedChange]);

  // Controls are read-only while a save is in flight, so focus moves once the request settled.
  useEffect(() => {
    if (focusRequest !== null) document.getElementById(`fact-${focusRequest.key}`)?.focus();
  }, [focusRequest]);

  function requestFocus(found: Record<string, string>): void {
    const first = market.facts.find((field) => found[field.key] !== undefined);
    if (first !== undefined)
      setFocusRequest((previous) => ({ key: first.key, n: (previous?.n ?? 0) + 1 }));
  }

  function onChange(key: string, value: string): void {
    setEditing({
      draft: { ...draft, [key]: value },
      base: edited && editing !== null ? editing.base : baseline,
    });
    setErrors((previous) => {
      if (previous[key] === undefined) return previous;
      const { [key]: _removed, ...rest } = previous;
      return rest;
    });
    setSaved(false);
  }

  function discardEdits(): void {
    setEditing(null);
    setErrors({});
    setFormError(null);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (saving.current || mutation.isPending || locked || conflict) return;
    setFormError(null);
    setSaved(false);

    const found = validateDraft(t, market.facts, draft, locale);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      requestFocus(found);
      return;
    }
    setErrors({});

    saving.current = true;
    mutation.mutate(
      { values: payloadFromDraft(market.facts, draft, values) },
      {
        onSuccess: () => {
          setEditing(null);
          setSaved(true);
        },
        onError: (error) => {
          if (error instanceof ApiRequestError && error.code === 'validation_failed') {
            const serverErrors: Record<string, string> = {};
            const unknownKeys: string[] = [];
            for (const [key, problem] of Object.entries(error.fields)) {
              const field = market.facts.find((candidate) => candidate.key === key);
              if (field === undefined) unknownKeys.push(key);
              else serverErrors[key] = factProblemMessage(t, field, problem, locale);
            }
            setErrors(serverErrors);
            requestFocus(serverErrors);
            if (Object.keys(serverErrors).length === 0) {
              setFormError(
                unknownKeys.length > 0
                  ? t('serverRefusedExtra', { fields: unknownKeys.join(', ') })
                  : t('checkForm'),
              );
            }
            return;
          }
          if (error instanceof ApiRequestError && error.code === 'inputs_locked') {
            // Another tab started a run: show the locked state the server now reports.
            void queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
          }
          setFormError(describeRequestFailure(tApi, error));
        },
        onSettled: () => {
          saving.current = false;
        },
      },
    );
  }

  const errorCount = locked ? 0 : Object.keys(errors).length;

  function renderField(field: FactFormField) {
    const id = idFor(field);
    const error = locked ? undefined : errors[field.key];
    const value = draft[field.key] ?? '';

    switch (field.type) {
      case 'enum': {
        // A stored value the profile no longer offers stays visible (and clearable via Unknown).
        const stale = value !== '' && !field.values.includes(value);
        return (
          <Field id={id} label={fieldLabel(field, locale)} required={field.required} error={error}>
            {(control) => (
              <select
                {...control}
                name={field.key}
                disabled={readOnly}
                value={value}
                onChange={(event) => onChange(field.key, event.target.value)}
                className={`select min-h-11 w-full ${error === undefined ? '' : 'select-error'}`}
              >
                <option value="">{t('unknown')}</option>
                {stale && (
                  <option value={value}>
                    {t('invalidValue')} {value}
                  </option>
                )}
                {field.values.map((option) => (
                  <option key={option} value={option}>
                    {optionLabel(field, option, locale)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        );
      }
      case 'boolean':
        return (
          <BooleanField
            field={field}
            id={id}
            value={value}
            error={error}
            disabled={readOnly}
            onChange={(next) => onChange(field.key, next)}
          />
        );
      case 'area':
      case 'volume':
      case 'money':
      case 'integer':
        return (
          // Text, not type=number: a number input reports '' for text the browser cannot parse
          // (such as "92,5" in an en-US browser), which would read as "cleared" and erase the
          // stored value on save.
          <Field
            id={id}
            label={fieldLabel(field, locale)}
            required={field.required}
            hint={fieldHint(t, field, locale)}
            error={error}
          >
            {(control) => (
              <input
                {...control}
                name={field.key}
                type="text"
                inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
                autoComplete="off"
                disabled={readOnly}
                value={value}
                onChange={(event) => onChange(field.key, event.target.value)}
                className={`input min-h-11 w-full ${error === undefined ? '' : 'input-error'}`}
              />
            )}
          </Field>
        );
      default: {
        const unreachable: never = field;
        return unreachable;
      }
    }
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      {formError !== null && (
        <div role="alert" className="alert alert-error">
          <span>{formError}</span>
        </div>
      )}
      {conflict && (
        <div role="alert" className="alert alert-warning">
          <span>{t('changedElsewhere')}</span>
          <button type="button" className="btn min-h-11" onClick={discardEdits}>
            {t('loadSaved')}
          </button>
        </div>
      )}
      <p className="text-sm text-base-content/70">{t('intro')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {market.facts.map((field) => (
          <div key={field.key}>{renderField(field)}</div>
        ))}
      </div>
      {extras > 0 && (
        <p className="text-sm text-base-content/70">{t('extras', { count: extras })}</p>
      )}
      {!locked && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="btn btn-outline min-h-11"
            disabled={mutation.isPending || !unsaved || conflict}
          >
            {mutation.isPending && (
              <span className="loading loading-spinner loading-sm" aria-hidden />
            )}
            {t('save')}
          </button>
          <span role="status" className="text-sm text-base-content/70">
            {saved && !unsaved ? t('saved') : unsaved ? t('unsaved') : ''}
          </span>
          {errorCount > 0 && (
            <span className="text-sm text-error">
              <span aria-hidden>× </span>
              {t('needAttention', { count: errorCount })}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
