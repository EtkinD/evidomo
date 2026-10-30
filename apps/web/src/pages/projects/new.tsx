import Head from 'next/head';
import Link from 'next/link';
import { CreateProjectForm } from '../../components/CreateProjectForm';
import { LoadError, LoadingBlock } from '../../components/PageStates';
import type { NextPageWithAuth } from '../../lib/page-auth';
import { useMarkets } from '../../lib/projects';

const NewProjectPage: NextPageWithAuth = () => {
  const markets = useMarkets();

  return (
    <>
      <Head>
        <title>New project — Evidomo</title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <Link href="/projects" className="link inline-flex min-h-11 w-fit items-center text-sm">
            Back to projects
          </Link>
          <section className="card border border-base-300 bg-base-100">
            <div className="card-body gap-6">
              <h1 className="card-title text-2xl">New project</h1>
              {markets.isPending && <LoadingBlock label="Loading markets…" cards={1} />}
              {markets.isError && (
                <LoadError
                  error={markets.error}
                  message="We could not load the markets. Check your connection and try again."
                  onRetry={() => void markets.refetch()}
                />
              )}
              {markets.isSuccess && markets.data.markets.length === 0 && (
                <div role="alert" className="alert alert-warning">
                  <span>No markets are available on this server yet.</span>
                </div>
              )}
              {markets.isSuccess && markets.data.markets.length > 0 && (
                <CreateProjectForm markets={markets.data.markets} />
              )}
            </div>
          </section>
        </div>
      </main>
    </>
  );
};

NewProjectPage.auth = 'required';

export default NewProjectPage;
