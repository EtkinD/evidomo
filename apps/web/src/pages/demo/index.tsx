import type { NextPage } from 'next';
import Head from 'next/head';
import { DemoBanner } from '../../components/demo/DemoBanner';
import { DemoRunList } from '../../components/demo/DemoRunList';

const DemoPage: NextPage = () => (
  <>
    <Head>
      <title>Demo — Evidomo</title>
    </Head>
    <main className="flex-1 bg-base-200 px-4 py-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <DemoBanner />
        <section className="card border border-base-300 bg-base-100">
          <div className="card-body gap-6">
            <div className="flex flex-col gap-2">
              <h1 className="card-title text-2xl">See Evidomo at work</h1>
              <p className="text-base-content/70">
                Replay a finished sample run: watch the steps, then open both review gates, the
                evidence behind every claim, and the listing pack. No account needed.
              </p>
            </div>
            <DemoRunList />
          </div>
        </section>
      </div>
    </main>
  </>
);

export default DemoPage;
