import { runParamsSchema } from '@evidomo/shared';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { RunMonitorView, LoadingState, RunNotFound } from '../../components/RunMonitor';
import type { NextPageWithAuth } from '../../lib/page-auth';
import { useRunMonitor } from '../../lib/use-run-monitor';

function RunMonitorPage({ runId }: { runId: string }) {
  const monitor = useRunMonitor(runId);
  return <RunMonitorView monitor={monitor} runId={runId} />;
}

const RunPage: NextPageWithAuth = () => {
  const router = useRouter();
  const params = runParamsSchema.safeParse({ runId: router.query['runId'] });

  return (
    <>
      <Head>
        <title>Run — Evidomo</title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <section className="card mx-auto max-w-5xl border border-base-300 bg-base-100">
          <div className="card-body gap-6">
            {!router.isReady ? (
              <LoadingState label="Loading the run…" />
            ) : params.success ? (
              <RunMonitorPage key={params.data.runId} runId={params.data.runId} />
            ) : (
              <RunNotFound />
            )}
          </div>
        </section>
      </main>
    </>
  );
};

RunPage.auth = 'required';

export default RunPage;
