import { runParamsSchema } from '@evidomo/shared';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { PackViewer } from '../../../components/PackViewer';
import { RunNotFound } from '../../../components/RunMonitor';
import { useExportManifest } from '../../../lib/pack';
import type { NextPageWithAuth } from '../../../lib/page-auth';

function PackPage({ runId }: { runId: string }) {
  const query = useExportManifest(runId);
  return <PackViewer query={query} runId={runId} />;
}

const RunPackPage: NextPageWithAuth = () => {
  const router = useRouter();
  const params = runParamsSchema.safeParse({ runId: router.query['runId'] });

  return (
    <>
      <Head>
        <title>Listing pack — Evidomo</title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <section className="card mx-auto max-w-4xl bg-base-100 shadow-sm">
          <div className="card-body gap-6">
            {!router.isReady ? null : params.success ? (
              <PackPage key={params.data.runId} runId={params.data.runId} />
            ) : (
              <RunNotFound />
            )}
          </div>
        </section>
      </main>
    </>
  );
};

RunPackPage.auth = 'required';

export default RunPackPage;
