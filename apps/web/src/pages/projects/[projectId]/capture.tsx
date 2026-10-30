import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { LoadError, LoadingBlock } from '../../../components/PageStates';
import { PhotoCapture } from '../../../components/PhotoCapture';
import { VoiceCapture, type VoiceStatus } from '../../../components/VoiceCapture';
import { ApiRequestError } from '../../../lib/api';
import { useLeaveGuard } from '../../../lib/leave-guard';
import type { NextPageWithAuth } from '../../../lib/page-auth';
import { readinessMessage } from '../../../lib/project-view';
import { useProject } from '../../../lib/projects';

const CapturePage: NextPageWithAuth = () => {
  const router = useRouter();
  const raw = router.query['projectId'];
  const projectId = router.isReady && typeof raw === 'string' ? raw : undefined;

  const project = useProject(projectId);
  const detail = project.data;
  const [photosPending, setPhotosPending] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  useLeaveGuard(photosPending || voiceStatus !== 'idle');

  let body;
  if (project.isError) {
    const missing = project.error instanceof ApiRequestError && project.error.status === 404;
    body = missing ? (
      <div role="alert" className="alert alert-error">
        <span>This project does not exist.</span>
      </div>
    ) : (
      <LoadError
        error={project.error}
        message="We could not load this project. Check your connection and try again."
        onRetry={() => void project.refetch()}
      />
    );
  } else if (detail === undefined) {
    body = <LoadingBlock label="Loading the project…" cards={3} />;
  } else {
    const { readiness } = detail;
    const captureItems = readiness.missing.filter((item) => item.kind !== 'fact');
    const factCount = readiness.missing.length - captureItems.length;
    body = (
      <>
        <header>
          <h1 className="text-3xl font-bold tracking-tight">Capture</h1>
          <p className="text-base-content/70">{detail.project.title}</p>
        </header>

        <section
          aria-labelledby="needed-heading"
          className="card border border-base-300 bg-base-100"
        >
          <div className="card-body gap-2">
            <h2 id="needed-heading" className="card-title text-2xl">
              What is still needed
            </h2>
            {photosPending && (
              <p className="font-medium">Photos are still uploading. Stay on this page.</p>
            )}
            {voiceStatus === 'recording' && (
              <p className="font-medium">A recording is in progress.</p>
            )}
            {voiceStatus === 'unsent' && (
              <p className="font-medium">A recording is ready but not uploaded yet.</p>
            )}
            {captureItems.length === 0 ? (
              !photosPending &&
              voiceStatus === 'idle' && <p>Photos and walkthrough are in place.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-6">
                {captureItems.map((item) => (
                  <li key={item.kind}>{readinessMessage(item, undefined)}</li>
                ))}
              </ul>
            )}
            {factCount > 0 && (
              <p className="text-sm text-base-content/70">
                {factCount === 1 ? '1 required fact is' : `${factCount} required facts are`} still
                missing on the project page.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {/* The photo grid can be long on a phone: a way to the walkthrough without scrolling. */}
              <a href="#voice-heading" className="btn btn-outline min-h-11 sm:hidden">
                Go to the voice walkthrough
              </a>
              {readiness.canStartRun && (
                <Link href={`/projects/${detail.project.id}`} className="btn btn-primary min-h-11">
                  Continue to start the run
                </Link>
              )}
            </div>
          </div>
        </section>

        <PhotoCapture
          key={`photos-${detail.project.id}`}
          detail={detail}
          onPendingChange={setPhotosPending}
        />
        <VoiceCapture
          key={`voice-${detail.project.id}`}
          detail={detail}
          onStatusChange={setVoiceStatus}
        />
      </>
    );
  }

  return (
    <>
      <Head>
        <title>
          {detail ? `Capture · ${detail.project.title} — Evidomo` : 'Capture — Evidomo'}
        </title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <Link
            href={projectId === undefined ? '/projects' : `/projects/${projectId}`}
            className="link inline-flex min-h-11 w-fit items-center text-sm"
          >
            Back to the project
          </Link>
          {body}
        </div>
      </main>
    </>
  );
};

CapturePage.auth = 'required';

export default CapturePage;
