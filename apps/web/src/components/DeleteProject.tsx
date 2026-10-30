import type { ProjectDetailResponse } from '@evidomo/shared';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { ApiRequestError } from '../lib/api';
import { setFlash } from '../lib/flash';
import { useDeleteProject } from '../lib/projects';
import { describeRequestFailure } from '../lib/request-failure';

type Problem = { kind: 'run_in_progress' } | { kind: 'message'; message: string };

/**
 * The project page's one destructive action. The dialog names the project and lists what goes;
 * it opens with focus on "Keep project", so Enter or a stray tap never deletes. Typing the name
 * is not required: the dialog already names it, a phone at a property is a poor keyboard, and
 * the focus default plus a verb-labelled button guard against accidents without that friction.
 */
export function DeleteProject({ detail }: { detail: ProjectDetailResponse }) {
  const t = useTranslations('deleteProject');
  const tApi = useTranslations('apiErrors');
  const router = useRouter();
  const { project, readiness, latestRun } = detail;
  const mutation = useDeleteProject(project.id);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [gone, setGone] = useState(false);
  const pending = mutation.isPending;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // The safe choice takes the initial focus (React renders no `autofocus` attribute).
      keepRef.current?.focus();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  function close(): void {
    if (pending) return;
    setOpen(false);
    setProblem(null);
  }

  function onDelete(): void {
    if (pending) return;
    setProblem(null);
    mutation.mutate(undefined, {
      onSuccess: () => {
        setFlash({ kind: 'project_deleted', title: project.title });
        void router.push('/projects');
      },
      onError: (error) => {
        if (error instanceof ApiRequestError && error.status === 404) {
          setGone(true);
          setFlash({ kind: 'project_gone' });
        } else if (error instanceof ApiRequestError && error.code === 'run_in_progress') {
          setProblem({ kind: 'run_in_progress' });
        } else {
          setProblem({ kind: 'message', message: describeRequestFailure(tApi, error) });
        }
      },
    });
  }

  const runId = readiness.activeRunId ?? latestRun?.id ?? null;

  return (
    <section
      aria-labelledby="delete-heading"
      className="flex flex-col gap-3 border-t-2 border-base-content/40 pt-5"
    >
      <h2 id="delete-heading" className="text-2xl font-medium">
        {t('heading')}
      </h2>
      <p className="text-base-content/70">{t('intro')}</p>
      <div>
        <button
          type="button"
          className="btn btn-outline btn-error min-h-11"
          onClick={() => setOpen(true)}
        >
          {t('open')}
        </button>
      </div>

      <dialog
        ref={dialogRef}
        className="modal"
        aria-labelledby={titleId}
        // Escape and the backdrop both close, except while the request is in flight.
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
        onClose={() => {
          if (!gone) {
            setOpen(false);
            setProblem(null);
          }
        }}
      >
        <div className="modal-box flex max-w-lg flex-col gap-4 bg-base-100 shadow-lift">
          <h2 id={titleId} className="text-2xl leading-tight font-medium break-words">
            {t('title', { title: project.title })}
          </h2>
          {gone ? (
            <>
              <div role="alert" className="alert alert-info">
                <span>{t('gone')}</span>
              </div>
              <div className="modal-action">
                <Link href="/projects" className="btn btn-primary min-h-11">
                  {t('goToProjects')}
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <p>{t('lead')}</p>
                <ul className="list-disc pl-6">
                  <li>{t('photos')}</li>
                  <li>{t('voice')}</li>
                  <li>{t('runs')}</li>
                </ul>
                <p className="text-sm text-base-content/70">{t('spend')}</p>
              </div>
              {problem?.kind === 'run_in_progress' && (
                <div role="alert" className="alert alert-warning alert-vertical items-start">
                  <span>{t('runInProgress')}</span>
                  {runId !== null && (
                    <Link href={`/runs/${runId}`} className="btn min-h-11">
                      {t('openMonitor')}
                    </Link>
                  )}
                </div>
              )}
              {problem?.kind === 'message' && (
                <div role="alert" className="alert alert-error">
                  <span>{problem.message}</span>
                </div>
              )}
              {pending && (
                <p role="status" className="text-sm text-base-content/70">
                  {t('deleting')}
                </p>
              )}
              <div className="modal-action flex-wrap">
                <button
                  type="button"
                  ref={keepRef}
                  className="btn min-h-11"
                  disabled={pending}
                  onClick={close}
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  className="btn btn-error min-h-11"
                  disabled={pending}
                  onClick={onDelete}
                >
                  {pending && <span className="loading loading-spinner loading-sm" aria-hidden />}
                  {t('confirm')}
                </button>
              </div>
            </>
          )}
        </div>
        <form method="dialog" className="modal-backdrop">
          <button tabIndex={-1} aria-hidden disabled={pending}>
            {t('cancel')}
          </button>
        </form>
      </dialog>
    </section>
  );
}
