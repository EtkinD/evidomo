import type { RunStatus } from '@evidomo/shared';
import { useTranslations } from 'use-intl';
import { runStatusBadge, runStatusLabel } from '../lib/project-view';

/** A run status as text plus a shape (spinner, check, or symbol), so colour is never the only cue. */
export function RunStatusBadge({ status }: { status: RunStatus }) {
  const t = useTranslations('status');
  return (
    <span className={`badge ${runStatusBadge(status)} gap-1`}>
      {(status === 'running' || status === 'queued') && (
        <span className="loading loading-spinner loading-xs" aria-hidden />
      )}
      {status === 'awaiting_gate' && <span aria-hidden>!</span>}
      {status === 'completed' && <span aria-hidden>✓</span>}
      {status === 'failed' && <span aria-hidden>×</span>}
      {runStatusLabel(t, status)}
    </span>
  );
}
