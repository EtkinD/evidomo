import type {
  OfficeProfileField,
  OfficeProfileValues,
  ProjectFormErrors,
} from '../lib/project-form';
import { Field } from './FormField';

interface OfficeProfileFieldsProps {
  idPrefix: string;
  values: OfficeProfileValues;
  errors: ProjectFormErrors;
  disabled?: boolean;
  onChange: (field: OfficeProfileField, value: string) => void;
}

/** The office profile snapshot a project keeps: shown on the pack, read by the creative step. */
export function OfficeProfileFields({
  idPrefix,
  values,
  errors,
  disabled = false,
  onChange,
}: OfficeProfileFieldsProps) {
  return (
    <fieldset className="flex flex-col gap-4 rounded-box border border-base-300 p-4">
      <legend className="px-2 font-semibold">Office profile</legend>
      <Field id={`${idPrefix}-agencyName`} label="Agency name" required error={errors.agencyName}>
        {(control) => (
          <input
            {...control}
            name="agencyName"
            autoComplete="organization"
            disabled={disabled}
            value={values.agencyName}
            onChange={(event) => onChange('agencyName', event.target.value)}
            className={`input min-h-11 w-full ${errors.agencyName === undefined ? '' : 'input-error'}`}
          />
        )}
      </Field>
      <Field
        id={`${idPrefix}-contactBlock`}
        label="Contact block"
        hint="Optional. Shown on the listing pack, for example address, phone, and website."
        error={errors.contactBlock}
      >
        {(control) => (
          <textarea
            {...control}
            name="contactBlock"
            rows={4}
            disabled={disabled}
            value={values.contactBlock}
            onChange={(event) => onChange('contactBlock', event.target.value)}
            className={`textarea w-full ${errors.contactBlock === undefined ? '' : 'textarea-error'}`}
          />
        )}
      </Field>
      <Field
        id={`${idPrefix}-tone`}
        label="Tone"
        hint="Optional. How the copy should sound, for example warm and professional."
        error={errors.tone}
      >
        {(control) => (
          <input
            {...control}
            name="tone"
            disabled={disabled}
            value={values.tone}
            onChange={(event) => onChange('tone', event.target.value)}
            className={`input min-h-11 w-full ${errors.tone === undefined ? '' : 'input-error'}`}
          />
        )}
      </Field>
    </fieldset>
  );
}
