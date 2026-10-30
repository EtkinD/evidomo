import type { RunExportFile, RunExportResponse } from '@evidomo/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { ApiRequestError } from '../lib/api';
import { formatBytes } from '../lib/pack';
import { useRunSource } from '../lib/run-source';
import { LoadErrorState, LoadingState, RunNotFound, SessionExpiredState } from './RunMonitor';

/**
 * `allow-same-origin` lets the page call `contentWindow.print()`; `allow-modals` lets the framed
 * document open the print dialog (Chrome ignores print() in a sandboxed frame without it).
 * `allow-scripts` is deliberately absent: the pack contains no script (its CSP is
 * `default-src 'none'`), and with scripts off, same-origin access exposes nothing to run.
 */
export const PACK_SANDBOX = 'allow-same-origin allow-modals';

const FILE_LABEL_KEYS = {
  html: 'files.html',
  portal_fields: 'files.portalFields',
  image: 'files.image',
} as const satisfies Record<RunExportFile['role'], string>;

function FileRow({ file }: { file: RunExportFile }) {
  const t = useTranslations('pack');
  const format = useFormatter();
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-box border border-base-300 bg-base-100 p-3">
      <div className="min-w-0">
        <p className="truncate font-medium">{file.fileName}</p>
        <p className="text-sm text-base-content/70">
          {t(FILE_LABEL_KEYS[file.role])} · {formatBytes(t, format, file.sizeBytes)}
        </p>
      </div>
      <a
        href={file.downloadUrl}
        download={file.fileName}
        className="btn min-h-11"
        aria-label={t('downloadLabel', { name: file.fileName })}
      >
        {t('download')}
      </a>
    </li>
  );
}

function PackReady({ pack }: { pack: RunExportResponse }) {
  const t = useTranslations('pack');
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, ...rest] = pack.files;
  if (html === undefined) return null;
  const json = rest.find((file) => file.role === 'portal_fields');
  const images = rest.filter((file) => file.role === 'image');

  function print(): void {
    try {
      const target = frame.current?.contentWindow;
      if (target) {
        target.focus();
        target.print();
        return;
      }
    } catch {
      // Printing a frame can be refused (privacy settings, embedded browsers): fall through.
    }
    window.open(html?.url, '_blank', 'noopener');
  }

  return (
    <>
      {pack.readyToPublish ? (
        <div role="status" className="alert alert-success">
          <span>
            <span aria-hidden>✓ </span>
            {t('ready')}
          </span>
        </div>
      ) : (
        <div role="alert" className="alert alert-warning">
          <div>
            <h2 className="font-semibold">
              <span aria-hidden>! </span>
              {t('notReady')}
            </h2>
            <p className="text-sm">{t('notReadyText')}</p>
          </div>
        </div>
      )}

      <section aria-labelledby="pack-preview-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pack-preview-heading" className="text-xl font-semibold">
            {t('preview')}
          </h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary min-h-11" onClick={print}>
              {t('print')}
            </button>
            <a href={html.url} target="_blank" rel="noopener" className="btn min-h-11">
              {t('fullScreen')}
            </a>
          </div>
        </div>
        <iframe
          ref={frame}
          title={t('previewTitle')}
          src={html.url}
          sandbox={PACK_SANDBOX}
          className="h-[70vh] w-full rounded-box border border-base-300 bg-base-100"
        />
      </section>

      <section aria-labelledby="pack-files-heading" className="flex flex-col gap-3">
        <h2 id="pack-files-heading" className="text-xl font-semibold">
          {t('downloads')}
        </h2>
        <ul className="flex flex-col gap-2">
          <FileRow file={html} />
          {json !== undefined && <FileRow file={json} />}
        </ul>
        {images.length > 0 && (
          <details className="rounded-box border border-base-300 bg-base-100 px-3">
            <summary className="flex min-h-11 cursor-pointer items-center font-medium">
              {t('images', { count: images.length })}
            </summary>
            <ul className="flex flex-col gap-2 pb-3">
              {images.map((file) => (
                <FileRow key={file.artifactId} file={file} />
              ))}
            </ul>
          </details>
        )}
      </section>
    </>
  );
}

function NotReady({ runId }: { runId: string }) {
  const t = useTranslations('pack');
  const source = useRunSource();
  return (
    <div role="status" className="alert alert-info alert-vertical sm:alert-horizontal">
      <span>{t('notReadyYet')}</span>
      <Link href={source.hrefs.monitor(runId)} className="btn min-h-11">
        {t('backToRun')}
      </Link>
    </div>
  );
}

function PackError({ query, runId }: { query: UseQueryResult<RunExportResponse>; runId: string }) {
  const t = useTranslations('pack');
  const { error } = query;
  if (error instanceof ApiRequestError) {
    if (error.status === 404) return <RunNotFound />;
    if (error.status === 409) return <NotReady runId={runId} />;
    if (error.status === 401) return <SessionExpiredState next={`/runs/${runId}/pack`} />;
  }
  return (
    <LoadErrorState message={t('loadError')} error={error} onRetry={() => void query.refetch()} />
  );
}

export function PackViewer({
  query,
  runId,
}: {
  query: UseQueryResult<RunExportResponse>;
  runId: string;
}) {
  const t = useTranslations('pack');
  const source = useRunSource();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={source.hrefs.monitor(runId)}
          className="link inline-flex min-h-11 w-fit items-center text-sm"
        >
          {t('backToRun')}
        </Link>
        <h1 className="card-title text-2xl">{t('title')}</h1>
      </div>
      {query.data !== undefined ? (
        <PackReady pack={query.data} />
      ) : query.isError ? (
        <PackError query={query} runId={runId} />
      ) : (
        <LoadingState label={t('loading')} rows={2} />
      )}
    </div>
  );
}
