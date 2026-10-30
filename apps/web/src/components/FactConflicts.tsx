import {
  displayUnit,
  type FactConflictDecision,
  type GateConflict,
  type GateConflictSide,
  type GateFact,
  type MarketForm,
} from '@evidomo/shared';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiRequestError } from '../lib/api';
import {
  buildEditRequest,
  editControlFor,
  editedMeasure,
  MAX_EDIT_TEXT,
  measureOptions,
  type EditControl,
  type EditResult,
} from '../lib/conflict-edit';
import { formatFactValue, keyLabel } from '../lib/evidence';
import { runEvidenceUrls, type EvidenceUrls } from '../lib/evidence-urls';
import {
  decisionSummary,
  describeDecisionFailure,
  useDecideConflict,
  useFactConflicts,
  useRunSnapshotRef,
} from '../lib/fact-conflicts';
import { fieldHint, humanize } from '../lib/project-view';
import { useMarketForm } from '../lib/projects';
import { EvidenceInspector } from './evidence/EvidenceInspector';
import { EvidenceProvider } from './evidence/EvidenceProvider';
import { Field } from './FormField';
import { LoadErrorState, LoadingState, RunNotFound, SessionExpiredState } from './RunMonitor';

type Decide = ReturnType<typeof useDecideConflict>;

export interface Labels {
  fact: (key: string) => string;
  value: (value: GateFact['value'], unit: string | null, basis: string | null) => string;
}

export function labelsFor(market: MarketForm | undefined): Labels {
  return {
    fact: (key) => market?.facts.find((fact) => fact.key === key)?.label ?? keyLabel(key),
    value: (value, unit, basis) =>
      formatFactValue(
        value,
        unit,
        basis,
        (id) => market?.areaBases.find((candidate) => candidate.id === id)?.label,
      ),
  };
}

const SOURCE_KIND_LABELS = {
  form: 'form field',
  transcript_turn: 'voice walkthrough',
  photo_region: 'photo',
  gate_decision: 'your decision',
} as const;

const NO_MEASURE = '__none__';

/** The select value back to what `buildEditRequest` expects: undefined is "not chosen yet". */
const pickOf = (value: string): string | undefined =>
  value === '' ? undefined : value === NO_MEASURE ? '' : value;

function EditValueForm({
  conflict,
  control,
  label,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  conflict: GateConflict;
  control: EditControl;
  label: string;
  busy: boolean;
  error: string | undefined;
  onSubmit: (result: Extract<EditResult, { ok: true }>) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [unitPick, setUnitPick] = useState('');
  const [basisPick, setBasisPick] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const firstControl = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const id = `${conflict.id}-edit`;

  // The button that opened the form is gone, so focus goes to the form's first control.
  useEffect(() => {
    firstControl.current?.focus();
  }, []);

  const unitOptions = measureOptions(conflict, control, 'unit');
  const basisOptions = measureOptions(conflict, control, 'basis');
  const picks = { unit: pickOf(unitPick), basis: pickOf(basisPick) };
  const choices: readonly string[] | null =
    control.kind === 'boolean' || (control.kind === 'market' && control.field.type === 'boolean')
      ? ['yes', 'no']
      : control.kind === 'market' && control.field.type === 'enum'
        ? control.field.values
        : null;
  const { unit: sharedUnit } = editedMeasure(conflict, control, picks);
  const hint =
    control.kind === 'market'
      ? fieldHint(control.field)
      : control.kind === 'number'
        ? unitOptions !== null
          ? 'A number. Choose its unit below.'
          : sharedUnit === null
            ? 'A number, with no unit.'
            : `A number, in ${displayUnit(sharedUnit)}.`
        : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = buildEditRequest(control, conflict, text, picks);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    setProblem(undefined);
    onSubmit(result);
  }

  const measureSelect = (
    pick: 'unit' | 'basis',
    options: string[],
    value: string,
    set: (value: string) => void,
  ) => (
    <Field id={`${id}-${pick}`} label={pick === 'unit' ? 'Unit' : 'Basis'}>
      {(controlProps) => (
        <select
          {...controlProps}
          className="select min-h-11 w-full"
          value={value}
          onChange={(event) => set(event.target.value)}
          disabled={busy}
        >
          <option value="">Choose…</option>
          {options.map((option) => (
            <option key={option} value={option === '' ? NO_MEASURE : option}>
              {option === '' ? (pick === 'unit' ? 'No unit' : 'No basis') : displayUnit(option)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-3 rounded-box bg-base-200 p-4">
      <Field id={id} label={`New value for ${label}`} hint={hint} error={problem ?? error}>
        {(controlProps) =>
          choices === null ? (
            <input
              {...controlProps}
              ref={firstControl}
              type="text"
              className={`input min-h-11 w-full ${controlProps['aria-invalid'] ? 'input-error' : ''}`}
              inputMode={control.kind === 'text' ? 'text' : 'decimal'}
              maxLength={control.kind === 'text' ? MAX_EDIT_TEXT : undefined}
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={busy}
            />
          ) : (
            <select
              {...controlProps}
              ref={firstControl}
              className={`select min-h-11 w-full ${controlProps['aria-invalid'] ? 'select-error' : ''}`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={busy}
            >
              <option value="">Choose…</option>
              {choices.map((choice) => (
                <option key={choice} value={choice}>
                  {humanize(choice)}
                </option>
              ))}
            </select>
          )
        }
      </Field>
      {unitOptions !== null && measureSelect('unit', unitOptions, unitPick, setUnitPick)}
      {basisOptions !== null && measureSelect('basis', basisOptions, basisPick, setBasisPick)}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary min-h-11" disabled={busy}>
          {busy && <span className="loading loading-spinner loading-xs" aria-hidden />}
          Save value
        </button>
        <button type="button" className="btn btn-ghost min-h-11" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SideCard({
  conflict,
  side,
  labels,
  kept,
  readOnly,
  busy,
  onUse,
}: {
  conflict: GateConflict;
  side: GateConflictSide;
  labels: Labels;
  kept: boolean;
  readOnly: boolean;
  busy: boolean;
  onUse: () => void;
}) {
  const headingId = `${conflict.id}-${side.factIds[0]}`;
  const valueText = labels.value(side.value, side.unit, side.basis);
  const kinds = [...new Set(side.sourceKinds)].map((kind) => SOURCE_KIND_LABELS[kind]);

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className={`flex flex-col gap-3 rounded-box bg-base-200 p-4 ${
        kept ? 'border-2 border-success' : 'border-2 border-transparent'
      }`}
    >
      <div className="flex flex-col gap-1">
        <p id={headingId} className="text-lg font-semibold">
          {valueText}
        </p>
        {side.key !== conflict.key && (
          <p className="text-sm text-base-content/70">{labels.fact(side.key)}</p>
        )}
        <p className="text-sm text-base-content/70">
          {side.facts.length === 1 ? '1 source' : `${side.facts.length} sources`}:{' '}
          {kinds.join(', ')}
        </p>
        {kept && (
          <span className="badge badge-success w-fit gap-1">
            <span aria-hidden>✓</span>Kept
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-3">
        {side.facts.map((fact) => (
          <li key={fact.id} className="border-t border-base-300 pt-3">
            <EvidenceInspector
              factId={fact.id}
              source={fact.source}
              valueText={labels.value(fact.value, fact.unit, fact.basis)}
              label={labels.fact(fact.key)}
            />
          </li>
        ))}
      </ul>
      {!readOnly && !kept && (
        <button
          type="button"
          className="btn btn-secondary min-h-11 self-start"
          aria-label={`Use this value: ${valueText}`}
          disabled={busy}
          onClick={onUse}
        >
          Use this value
        </button>
      )}
    </div>
  );
}

function ConflictCard({
  conflict,
  labels,
  market,
  marketLoading,
  decide,
  readOnly,
  editing,
  onEditingChange,
}: {
  conflict: GateConflict;
  labels: Labels;
  market: MarketForm | undefined;
  marketLoading: boolean;
  decide: Decide;
  readOnly: boolean;
  editing: boolean;
  onEditingChange: (open: boolean) => void;
}) {
  const headingId = `${conflict.id}-title`;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const label = labels.fact(conflict.key);
  const control = useMemo(() => editControlFor(conflict, market), [conflict, market]);
  const busy = decide.isPending;
  const thisPending = busy && decide.variables?.conflictId === conflict.id;
  const failure =
    decide.isError && decide.variables?.conflictId === conflict.id ? decide.error : null;
  // An error belongs under the form only when the form's own save failed; any other failure (or
  // one that closed the form, like a gate that is no longer open) is shown on the card.
  const formFailure = failure !== null && decide.variables?.body.choice === 'edit' && editing;
  const decision: FactConflictDecision | null = conflict.decision;

  function send(body: Parameters<Decide['mutate']>[0]['body']) {
    decide.mutate(
      { conflictId: conflict.id, body },
      {
        // The button that was pressed may be gone now; keep keyboard and screen reader users here.
        onSuccess: () => {
          onEditingChange(false);
          headingRef.current?.focus();
        },
      },
    );
  }

  const summary =
    decision === null
      ? null
      : decisionSummary(
          decision,
          (factIds) => {
            const side = conflict.sides.find((s) => s.factIds.some((id) => factIds.includes(id)));
            return side === undefined ? undefined : labels.value(side.value, side.unit, side.basis);
          },
          (edit) => labels.value(edit.value, edit.unit, edit.basis),
        );

  return (
    <li>
      <div
        role="group"
        aria-labelledby={headingId}
        className={`flex flex-col gap-4 rounded-box border bg-base-100 p-4 ${
          decision === null ? 'border-warning' : 'border-base-300'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
            {label}
          </h2>
          <span className={`badge gap-1 ${decision === null ? 'badge-warning' : 'badge-success'}`}>
            <span aria-hidden>{decision === null ? '!' : '✓'}</span>
            {decision === null ? 'Open' : 'Decided'}
          </span>
        </div>
        <p>{conflict.explanation}</p>
        <ul aria-label="Values in conflict" className="grid grid-cols-2 gap-2">
          {conflict.sides.map((side) => (
            <li
              key={side.factIds.join()}
              className="flex flex-col rounded-box border border-base-300 p-2"
            >
              <span className="font-semibold">
                {labels.value(side.value, side.unit, side.basis)}
              </span>
              <span className="text-sm text-base-content/70">
                {side.facts.length === 1 ? '1 source' : `${side.facts.length} sources`}
              </span>
            </li>
          ))}
        </ul>
        <div className="grid gap-4 md:grid-cols-2">
          {conflict.sides.map((side) => (
            <SideCard
              key={side.factIds.join()}
              conflict={conflict}
              side={side}
              labels={labels}
              kept={
                decision?.choice === 'accept' &&
                side.factIds.some((id) => decision.factIds.includes(id))
              }
              readOnly={readOnly}
              busy={busy}
              onUse={() => {
                const factId = side.factIds[0];
                if (factId !== undefined) send({ choice: 'accept', factId });
              }}
            />
          ))}
        </div>
        {summary !== null && <p className="text-sm font-medium">{summary}</p>}
        {thisPending && (
          <p role="status" className="flex items-center gap-2 text-sm text-base-content/70">
            <span className="loading loading-spinner loading-xs" aria-hidden />
            Saving your decision…
          </p>
        )}
        {failure !== null && !formFailure && (
          <p role="alert" className="text-sm text-error">
            {describeDecisionFailure(failure)}
          </p>
        )}
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            {decision?.choice !== 'reject' && (
              <button
                type="button"
                className="btn btn-outline min-h-11"
                aria-label={`Reject all values for ${label}`}
                disabled={busy}
                onClick={() => send({ choice: 'reject' })}
              >
                Reject all
              </button>
            )}
            {!editing && (
              <button
                type="button"
                className="btn btn-outline min-h-11"
                aria-label={`Enter a value for ${label}`}
                disabled={busy || marketLoading}
                onClick={() => {
                  decide.reset();
                  onEditingChange(true);
                }}
              >
                Enter a value
              </button>
            )}
            {marketLoading && (
              <span className="text-sm text-base-content/70">Loading the field type…</span>
            )}
          </div>
        )}
        {!readOnly && editing && (
          <EditValueForm
            conflict={conflict}
            control={control}
            label={label}
            busy={busy}
            error={formFailure ? describeDecisionFailure(failure) : undefined}
            onSubmit={(result) => send(result.body)}
            onCancel={() => onEditingChange(false)}
          />
        )}
      </div>
    </li>
  );
}

function Progress({ total, open }: { total: number; open: number }) {
  return (
    <section
      aria-label="Progress"
      className="flex flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-4"
    >
      <p className="font-medium">
        {open} of {total} {total === 1 ? 'conflict' : 'conflicts'} still open
      </p>
      <progress
        className="progress progress-primary w-full"
        value={total - open}
        max={total}
        aria-label="Conflicts decided"
      />
    </section>
  );
}

/** `urls` overrides where the evidence files are served from (default: the owner's run routes). */
export function FactConflictsView({
  runId,
  urls: urlsOverride,
}: {
  runId: string;
  urls?: EvidenceUrls;
}) {
  const gate = useFactConflicts(runId);
  const snapshot = useRunSnapshotRef(runId);
  const marketQuery = useMarketForm(
    snapshot.data === undefined
      ? undefined
      : { id: snapshot.data.marketProfileId, version: snapshot.data.marketProfileVersion },
  );
  const market = marketQuery.data?.market;
  // Whether a key is a market key is only known once the profile is there; a failed load falls
  // back to typing the value from the sides.
  const marketLoading = snapshot.isLoading || marketQuery.isLoading;
  const [editingId, setEditingId] = useState<string | null>(null);
  const decide = useDecideConflict(runId);
  const labels = useMemo(() => labelsFor(market), [market]);
  const urls = useMemo(() => urlsOverride ?? runEvidenceUrls(runId), [runId, urlsOverride]);

  if (gate.data === undefined) {
    if (!gate.isError) {
      return <LoadingState label="Loading the fact conflicts…" rows={2} />;
    }
    if (gate.error instanceof ApiRequestError && gate.error.status === 404) return <RunNotFound />;
    if (gate.error instanceof ApiRequestError && gate.error.status === 401) {
      return <SessionExpiredState next={`/runs/${runId}/conflicts`} />;
    }
    return (
      <LoadErrorState
        message="We could not load the fact conflicts. Check your connection and try again."
        onRetry={() => void gate.refetch()}
      />
    );
  }

  const data = gate.data;
  const readOnly = data.state !== 'open';
  const list = (
    <ol className="flex flex-col gap-4">
      {data.conflicts.map((conflict) => (
        <ConflictCard
          key={conflict.id}
          conflict={conflict}
          labels={labels}
          market={market}
          marketLoading={marketLoading}
          decide={decide}
          readOnly={readOnly}
          editing={!readOnly && editingId === conflict.id}
          onEditingChange={(open) => setEditingId(open ? conflict.id : null)}
        />
      ))}
    </ol>
  );

  return (
    <EvidenceProvider urls={urls}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Link
            href={`/runs/${runId}`}
            className="link inline-flex min-h-11 w-fit items-center text-sm"
          >
            Back to run
          </Link>
          <h1 className="card-title text-2xl">
            {data.state === 'open' ? 'Resolve fact conflicts' : 'Fact conflicts'}
          </h1>
        </div>

        {decide.data?.resumed === true && (
          <div role="status" className="alert alert-success alert-vertical sm:alert-horizontal">
            <span>All conflicts are decided. The run is continuing.</span>
            <Link href={`/runs/${runId}`} className="btn min-h-11">
              Back to the run
            </Link>
          </div>
        )}

        {data.state === 'not_reached' && (
          <div role="status" className="alert alert-info alert-vertical sm:alert-horizontal">
            <span>
              The run has not reached this review yet. The conflicts appear here once the facts have
              been compared.
            </span>
          </div>
        )}
        {data.state === 'suspended' && (
          <div role="alert" className="alert alert-warning">
            <span>
              The run stopped while waiting for this review, so decisions are paused. Resume the run
              from its page to reopen the review; the decisions you made are kept.
            </span>
          </div>
        )}
        {data.state === 'released' && decide.data?.resumed !== true && (
          <div role="status" className="alert alert-info">
            <span>
              {data.conflictCount === 0
                ? 'No conflicts needed a decision.'
                : 'This review is finished. Your decisions are shown below.'}
            </span>
          </div>
        )}

        {data.state === 'open' && (
          <>
            <p className="text-base-content/70">
              These facts disagree. Compare the evidence for each value, then keep one, reject them
              all, or enter the right value. The run continues after the last decision.
            </p>
            <Progress total={data.conflictCount} open={data.openCount} />
          </>
        )}
        {data.conflicts.length > 0 && list}
      </div>
    </EvidenceProvider>
  );
}
