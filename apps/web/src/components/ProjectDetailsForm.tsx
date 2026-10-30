import type { ProjectDetailResponse } from '@evidomo/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiRequestError } from '../lib/api';
import {
  describeProjectFailure,
  officeProfileToValues,
  PROJECT_FORM_FIELDS,
  sameOfficeProfile,
  validateProjectDetails,
  type CreateProjectValues,
  type OfficeProfileField,
  type OfficeProfileValues,
  type ProjectFormErrors,
} from '../lib/project-form';
import { projectKey, useUpdateProject } from '../lib/projects';
import { Field } from './FormField';
import { OfficeProfileFields } from './OfficeProfileFields';

const ID = 'details';

interface DetailsDraft {
  title: string;
  office: OfficeProfileValues;
}

interface Editing {
  draft: DetailsDraft;
  base: DetailsDraft;
}

function sameDetails(a: DetailsDraft, b: DetailsDraft, includeOffice: boolean): boolean {
  return (
    a.title.trim() === b.title.trim() && (!includeOffice || sameOfficeProfile(a.office, b.office))
  );
}

/**
 * Title and office profile. The title can always change; the office profile only while inputs
 * are not locked (the creative step reads it), and then it is sent only when it changed.
 *
 * The saved project (props) is the source of truth. Edits live in `editing`, with the saved
 * values they started from: an untouched form follows new saved values, an edited one asks
 * before discarding (see `FactForm`).
 */
export function ProjectDetailsForm({
  detail,
  onUnsavedChange,
}: {
  detail: ProjectDetailResponse;
  onUnsavedChange?: (unsaved: boolean) => void;
}) {
  const { project, readiness } = detail;
  const locked = readiness.inputsLocked;
  const queryClient = useQueryClient();
  const mutation = useUpdateProject(project.id);
  const saving = useRef(false);

  const saved: DetailsDraft = {
    title: project.title,
    office: officeProfileToValues(project.officeProfile),
  };
  const [editing, setEditing] = useState<Editing | null>(null);
  const [errors, setErrors] = useState<ProjectFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number } | null>(null);

  // While locked the office profile always shows the saved values; only the title can differ.
  const effective = (draft: DetailsDraft): DetailsDraft =>
    locked ? { title: draft.title, office: saved.office } : draft;
  const edited =
    editing !== null &&
    !sameDetails(effective(editing.draft), saved, !locked) &&
    !sameDetails(effective(editing.draft), effective(editing.base), !locked);
  const conflict = edited && editing !== null && !sameDetails(editing.base, saved, !locked);
  const draft = edited && editing !== null ? effective(editing.draft) : saved;
  const readOnly = mutation.isPending;
  const titleChanged = draft.title.trim() !== project.title;
  const officeChanged = !locked && !sameOfficeProfile(draft.office, saved.office);

  useEffect(() => {
    onUnsavedChange?.(edited);
  }, [edited, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange?.(false), [onUnsavedChange]);

  useEffect(() => {
    if (focusRequest !== null) document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);

  const values: CreateProjectValues = {
    title: draft.title,
    ...draft.office,
    market: '',
    outputLanguage: project.outputLanguage,
  };

  function update(next: DetailsDraft): void {
    setEditing({ draft: next, base: edited && editing !== null ? editing.base : saved });
    setJustSaved(false);
  }

  function clearError(field: keyof ProjectFormErrors): void {
    setErrors((previous) => {
      if (previous[field] === undefined) return previous;
      const { [field]: _removed, ...rest } = previous;
      return rest;
    });
  }

  function discardEdits(): void {
    setEditing(null);
    setErrors({});
    setFormError(null);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (saving.current || mutation.isPending || !edited || conflict) return;
    setFormError(null);
    setJustSaved(false);

    const validation = validateProjectDetails(values, {
      title: titleChanged,
      officeProfile: officeChanged,
    });
    if (!validation.ok) {
      setErrors(validation.errors);
      const first = PROJECT_FORM_FIELDS.find((field) => validation.errors[field] !== undefined);
      if (first !== undefined)
        setFocusRequest((p) => ({ id: `${ID}-${first}`, n: (p?.n ?? 0) + 1 }));
      return;
    }
    setErrors({});

    saving.current = true;
    mutation.mutate(validation.data, {
      onSuccess: () => {
        setEditing(null);
        setJustSaved(true);
      },
      onError: (error) => {
        if (error instanceof ApiRequestError && error.code === 'inputs_locked') {
          // A run started elsewhere: refetch so the form shows the locked state.
          void queryClient.invalidateQueries({ queryKey: projectKey(project.id) });
        }
        const failure = describeProjectFailure(error, values);
        if (failure.kind === 'fields') {
          setErrors(failure.errors);
          const first = PROJECT_FORM_FIELDS.find((field) => failure.errors[field] !== undefined);
          if (first !== undefined) {
            setFocusRequest((p) => ({ id: `${ID}-${first}`, n: (p?.n ?? 0) + 1 }));
          }
        } else {
          setFormError(failure.message);
        }
      },
      onSettled: () => {
        saving.current = false;
      },
    });
  }

  function onOfficeChange(field: OfficeProfileField, value: string): void {
    update({ title: draft.title, office: { ...draft.office, [field]: value } });
    clearError(field);
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      {locked && (
        <div role="note" className="alert alert-info">
          <span>
            A run has been started, so the office profile is locked. The title can still be changed.
          </span>
        </div>
      )}
      {formError !== null && (
        <div role="alert" className="alert alert-error">
          <span>{formError}</span>
        </div>
      )}
      {conflict && (
        <div role="alert" className="alert alert-warning">
          <span>Saved values changed elsewhere. Your edits were not saved.</span>
          <button type="button" className="btn min-h-11" onClick={discardEdits}>
            Load saved values
          </button>
        </div>
      )}
      <Field id={`${ID}-title`} label="Project title" required error={errors.title}>
        {(control) => (
          <input
            {...control}
            name="title"
            autoComplete="off"
            disabled={readOnly}
            value={draft.title}
            onChange={(event) => {
              update({ title: event.target.value, office: draft.office });
              clearError('title');
            }}
            className={`input w-full ${errors.title === undefined ? '' : 'input-error'}`}
          />
        )}
      </Field>
      <OfficeProfileFields
        idPrefix={ID}
        values={draft.office}
        errors={errors}
        disabled={locked || readOnly}
        onChange={onOfficeChange}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="btn btn-outline min-h-11"
          disabled={mutation.isPending || !edited || conflict}
        >
          {mutation.isPending && (
            <span className="loading loading-spinner loading-sm" aria-hidden />
          )}
          Save details
        </button>
        <span role="status" className="text-sm text-base-content/70">
          {justSaved && !edited ? 'Details saved.' : edited ? 'You have unsaved changes.' : ''}
        </span>
      </div>
    </form>
  );
}
