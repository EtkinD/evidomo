import { runParamsSchema } from '@evidomo/shared';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { FactConflictsView } from '../../../components/FactConflicts';
import { RunNotFound } from '../../../components/RunMonitor';
import type { NextPageWithAuth } from '../../../lib/page-auth';

const ConflictsPage: NextPageWithAuth = () => {
  const router = useRouter();
  const params = runParamsSchema.safeParse({ runId: router.query['runId'] });

  return (
    <>
      <Head>
        <title>Fact conflicts — Evidomo</title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <section className="card mx-auto max-w-4xl bg-base-100 shadow-sm">
          <div className="card-body gap-6">
            {!router.isReady ? null : params.success ? (
              <FactConflictsView key={params.data.runId} runId={params.data.runId} />
            ) : (
              <RunNotFound />
            )}
          </div>
        </section>
      </main>
    </>
  );
};

ConflictsPage.auth = 'required';

export default ConflictsPage;
