import type { RunExportFile, RunExportResponse } from '@evidomo/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef } from 'react';
import { ApiRequestError } from '../lib/api';
import { withNext } from '../lib/next-path';
import { formatBytes } from '../lib/pack';
import { RunNotFound } from './RunMonitor';

/**
 * `allow-same-origin` lets the page call `contentWindow.print()`; `allow-modals` lets the framed
 * document open the print dialog (Chrome ignores print() in a sandboxed frame without it).
 * `allow-scripts` is deliberately absent: the pack contains no script (its CSP is
 * `default-src 'none'`), and with scripts off, same-origin access exposes nothing to run.
 */
export const PACK_SANDBOX = 'allow-same-origin allow-modals';

const FILE_LABELS: Record<RunExportFile['role'], string> = {
  html: 'Listing pack (HTML)',
  portal_fields: 'Portal fields (JSON)',
  image: 'Image',
};

function FileRow({ file }: { file: RunExportFile }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-box border border-base-300 p-3">
      <div className="min-w-0">
        <p className="truncate font-medium">{file.fileName}</p>
        <p className="text-sm text-base-content/70">
          {FILE_LABELS[file.role]} · {formatBytes(file.sizeBytes)}
        </p>
      </div>
      <a
        href={file.downloadUrl}
        download={file.fileName}
        className="btn min-h-11"
        aria-label={`Download ${file.fileName}`}
      >
        Download
      </a>
    </li>
  );
}

function PackReady({ pack }: { pack: RunExportResponse }) {
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
          <span>Ready to publish: every publication check passed.</span>
        </div>
      ) : (
        <div role="alert" className="alert alert-warning">
          <div>
            <h2 className="font-semibold">Not ready to publish</h2>
            <p className="text-sm">
              At least one publication check failed. The checklist inside the pack shows which; fix
              them before this listing goes out.
            </p>
          </div>
        </div>
      )}

      <section aria-labelledby="pack-preview-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pack-preview-heading" className="text-lg font-semibold">
            Preview
          </h2>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary min-h-11" onClick={print}>
              Print / Save as PDF
            </button>
            <a href={html.url} target="_blank" rel="noopener" className="btn min-h-11">
              Open full screen
            </a>
          </div>
        </div>
        <iframe
          ref={frame}
          title="Listing pack preview"
          src={html.url}
          sandbox={PACK_SANDBOX}
          className="h-[70vh] w-full rounded-box border border-base-300 bg-base-100"
        />
      </section>

      <section aria-labelledby="pack-files-heading" className="flex flex-col gap-3">
        <h2 id="pack-files-heading" className="text-lg font-semibold">
          Downloads
        </h2>
        <ul className="flex flex-col gap-2">
          <FileRow file={html} />
          {json !== undefined && <FileRow file={json} />}
        </ul>
        {images.length > 0 && (
          <details className="rounded-box border border-base-300 p-3">
            <summary className="cursor-pointer font-medium">Images ({images.length})</summary>
            <ul className="mt-3 flex flex-col gap-2">
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
  return (
    <div role="status" className="alert alert-info">
      <span>The pack is not ready yet. It appears once the run has finished its export.</span>
      <Link href={`/runs/${runId}`} className="btn min-h-11">
        Back to the run
      </Link>
    </div>
  );
}

function PackError({ query, runId }: { query: UseQueryResult<RunExportResponse>; runId: string }) {
  const { error } = query;
  if (error instanceof ApiRequestError) {
    if (error.status === 404) return <RunNotFound />;
    if (error.status === 409) return <NotReady runId={runId} />;
    if (error.status === 401) {
      return (
        <div role="alert" className="alert alert-warning">
          <span>Your session has expired.</span>
          <Link href={withNext('/login', `/runs/${runId}/pack`)} className="btn min-h-11">
            Log in again
          </Link>
        </div>
      );
    }
  }
  return (
    <div role="alert" className="alert alert-error">
      <span>We could not load this pack. Check your connection and try again.</span>
      <button type="button" className="btn min-h-11" onClick={() => void query.refetch()}>
        Try again
      </button>
    </div>
  );
}

export function PackViewer({
  query,
  runId,
}: {
  query: UseQueryResult<RunExportResponse>;
  runId: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="card-title text-2xl">Listing pack</h1>
        <Link href={`/runs/${runId}`} className="link inline-flex min-h-11 items-center text-sm">
          Back to the run
        </Link>
      </div>
      {query.data !== undefined ? (
        <PackReady pack={query.data} />
      ) : query.isError ? (
        <PackError query={query} runId={runId} />
      ) : (
        <div role="status" className="flex items-center gap-3 text-base-content/70">
          <span className="loading loading-spinner" aria-hidden />
          <span>Loading the pack…</span>
        </div>
      )}
    </div>
  );
}
