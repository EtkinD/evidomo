import type { MarketSummary } from '@evidomo/shared';
import { useRouter } from 'next/router';
import { useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import {
  describeProjectFailure,
  emptyOfficeProfile,
  marketValue,
  PROJECT_FORM_FIELDS,
  type ProjectFormField,
  validateCreateProject,
  type CreateProjectValues,
  type OfficeProfileField,
  type ProjectFormErrors,
} from '../lib/project-form';
import { useCreateProject } from '../lib/projects';
import { languageName } from '../lib/project-view';
import { Field } from './FormField';
import { OfficeProfileFields } from './OfficeProfileFields';

const ID = 'create-project';

/**
 * Create form. The market selection and the language override are the only derived state: the
 * effective language is computed from them, so there is no effect to keep the two in sync.
 */
export function CreateProjectForm({ markets }: { markets: readonly MarketSummary[] }) {
  const t = useTranslations('projectForm');
  const tApi = useTranslations('apiErrors');
  const locale = useLocale();
  const router = useRouter();
  const mutation = useCreateProject();
  // A ref, not mutation state: two submits in the same tick both see isPending as false.
  const submitting = useRef(false);

  const [title, setTitle] = useState('');
  const [office, setOffice] = useState(emptyOfficeProfile);
  const [marketChoice, setMarketChoice] = useState<string | null>(null);
  const [languageChoice, setLanguageChoice] = useState<string | null>(null);
  const [errors, setErrors] = useState<ProjectFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const firstMarket = markets[0];
  const market =
    markets.find((candidate) => marketValue(candidate) === marketChoice) ?? firstMarket;
  const languages = market?.outputLanguages ?? [];
  const outputLanguage =
    languageChoice !== null && languages.includes(languageChoice)
      ? languageChoice
      : (market?.defaultOutputLanguage ?? '');

  const values: CreateProjectValues = {
    title,
    ...office,
    market: market === undefined ? '' : marketValue(market),
    outputLanguage,
  };

  function focusFirstInvalid(found: ProjectFormErrors): void {
    const first = PROJECT_FORM_FIELDS.find((field) => found[field] !== undefined);
    if (first !== undefined) document.getElementById(`${ID}-${first}`)?.focus();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // After success the page is only waiting for the navigation; a second submit would create a duplicate.
    if (submitting.current || mutation.isPending || mutation.isSuccess) return;
    setFormError(null);

    const validation = validateCreateProject(t, values);
    if (!validation.ok) {
      setErrors(validation.errors);
      focusFirstInvalid(validation.errors);
      return;
    }
    setErrors({});

    submitting.current = true;
    mutation.mutate(validation.data, {
      onSuccess: ({ project }) => {
        void router.push(`/projects/${project.id}`);
      },
      onError: (error) => {
        submitting.current = false;
        const failure = describeProjectFailure(t, tApi, error, values);
        if (failure.kind === 'fields') {
          setErrors(failure.errors);
          focusFirstInvalid(failure.errors);
        } else {
          setFormError(failure.message);
        }
      },
    });
  }

  function clearError(field: ProjectFormField): void {
    setErrors((previous) => {
      if (previous[field] === undefined) return previous;
      const { [field]: _removed, ...rest } = previous;
      return rest;
    });
  }

  function onOfficeChange(field: OfficeProfileField, value: string): void {
    setOffice((previous) => ({ ...previous, [field]: value }));
    clearError(field);
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      {formError !== null && (
        <div role="alert" className="alert alert-error">
          <span>{formError}</span>
        </div>
      )}

      <Field id={`${ID}-title`} label={t('title')} required error={errors.title}>
        {(control) => (
          <input
            {...control}
            name="title"
            autoComplete="off"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              clearError('title');
            }}
            className={`input min-h-11 w-full ${errors.title === undefined ? '' : 'input-error'}`}
          />
        )}
      </Field>

      <OfficeProfileFields
        idPrefix={ID}
        values={office}
        errors={errors}
        onChange={onOfficeChange}
      />

      <fieldset className="flex flex-col gap-4 rounded-box border border-base-300 p-4">
        <legend className="px-2 font-semibold">{t('marketAndLanguage')}</legend>
        <Field id={`${ID}-market`} label={t('market')} required error={errors.market}>
          {(control) => (
            <select
              {...control}
              name="market"
              value={values.market}
              onChange={(event) => {
                setMarketChoice(event.target.value);
                clearError('market');
              }}
              className={`select min-h-11 w-full ${errors.market === undefined ? '' : 'select-error'}`}
            >
              {markets.map((candidate) => (
                <option key={marketValue(candidate)} value={marketValue(candidate)}>
                  {candidate.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id={`${ID}-outputLanguage`}
          label={t('outputLanguage')}
          required
          hint={t('outputLanguageHint')}
          error={errors.outputLanguage}
        >
          {(control) => (
            <select
              {...control}
              name="outputLanguage"
              value={outputLanguage}
              onChange={(event) => {
                setLanguageChoice(event.target.value);
                clearError('outputLanguage');
              }}
              className={`select min-h-11 w-full ${errors.outputLanguage === undefined ? '' : 'select-error'}`}
            >
              {languages.map((code) => (
                <option key={code} value={code}>
                  {languageName(code, locale)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </fieldset>

      <button
        type="submit"
        className="btn btn-primary w-full min-h-11"
        disabled={mutation.isPending || mutation.isSuccess}
      >
        {mutation.isPending && <span className="loading loading-spinner loading-sm" aria-hidden />}
        {t('create')}
      </button>
    </form>
  );
}
