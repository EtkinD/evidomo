import { runParamsSchema } from '@evidomo/shared';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { RunMonitorView, RunNotFound } from '../../components/RunMonitor';
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
        <section className="card mx-auto max-w-3xl bg-base-100 shadow-sm">
          <div className="card-body gap-6">
            {!router.isReady ? null : params.success ? (
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
