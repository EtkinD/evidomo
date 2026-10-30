import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { LoadError, LoadingBlock } from '../../../components/PageStates';
import { PhotoCapture } from '../../../components/PhotoCapture';
import { VoiceCapture, type VoiceStatus } from '../../../components/VoiceCapture';
import { ApiRequestError } from '../../../lib/api';
import { getServerSideProps } from '../../../lib/i18n-server';
import { useLeaveGuard } from '../../../lib/leave-guard';
import type { NextPageWithAuth } from '../../../lib/page-auth';
import { readinessMessage } from '../../../lib/project-view';
import { useProject } from '../../../lib/projects';

export { getServerSideProps };

const CapturePage: NextPageWithAuth = () => {
  const t = useTranslations('capture');
  const tReadiness = useTranslations('readiness');
  const tCommon = useTranslations('common');
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
        <span>{tCommon('projectMissing')}</span>
      </div>
    ) : (
      <LoadError
        error={project.error}
        message={tCommon('projectLoadError')}
        onRetry={() => void project.refetch()}
      />
    );
  } else if (detail === undefined) {
    body = <LoadingBlock label={tCommon('loadingProject')} cards={3} />;
  } else {
    const { readiness } = detail;
    const captureItems = readiness.missing.filter((item) => item.kind !== 'fact');
    const factCount = readiness.missing.length - captureItems.length;
    body = (
      <>
        <header>
          <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-base-content/70">{detail.project.title}</p>
        </header>

        <section
          aria-labelledby="needed-heading"
          className="card border border-base-300 bg-base-100"
        >
          <div className="card-body gap-2">
            <h2 id="needed-heading" className="card-title text-2xl">
              {t('stillNeeded')}
            </h2>
            {photosPending && <p className="font-medium">{t('uploading')}</p>}
            {voiceStatus === 'recording' && <p className="font-medium">{t('recordingNow')}</p>}
            {voiceStatus === 'unsent' && <p className="font-medium">{t('recordingUnsent')}</p>}
            {captureItems.length === 0 ? (
              !photosPending && voiceStatus === 'idle' && <p>{t('inPlace')}</p>
            ) : (
              <ul className="list-disc space-y-1 pl-6">
                {captureItems.map((item) => (
                  <li key={item.kind}>{readinessMessage(tReadiness, item, undefined)}</li>
                ))}
              </ul>
            )}
            {factCount > 0 && (
              <p className="text-sm text-base-content/70">
                {t('factsMissing', { count: factCount })}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {/* The photo grid can be long on a phone: a way to the walkthrough without scrolling. */}
              <a href="#voice-heading" className="btn btn-outline min-h-11 sm:hidden">
                {t('goToVoice')}
              </a>
              {readiness.canStartRun && (
                <Link href={`/projects/${detail.project.id}`} className="btn btn-primary min-h-11">
                  {t('continue')}
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
          {detail ? t('pageTitleFor', { title: detail.project.title }) : t('pageTitle')}
        </title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <Link
            href={projectId === undefined ? '/projects' : `/projects/${projectId}`}
            className="link inline-flex min-h-11 w-fit items-center text-sm"
          >
            {t('back')}
          </Link>
          {body}
        </div>
      </main>
    </>
  );
};

CapturePage.auth = 'required';

export default CapturePage;
