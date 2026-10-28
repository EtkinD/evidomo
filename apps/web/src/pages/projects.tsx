import Head from 'next/head';
import { useMe } from '../lib/auth';
import type { NextPageWithAuth } from '../lib/page-auth';

// The signed-in landing page. Project creation and the project list replace the empty state
// with P4-02.
const ProjectsPage: NextPageWithAuth = () => {
  // RequireAuth renders this page only once `me` holds a user.
  const { data: user } = useMe();

  return (
    <>
      <Head>
        <title>Your projects — Evidomo</title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <div>
            <h1 className="text-3xl font-bold">Your projects</h1>
            {user && <p className="text-base-content/70">Signed in as {user.email}</p>}
          </div>
          <div className="card bg-base-100 shadow-sm">
            <div className="card-body items-center text-center">
              <h2 className="card-title">No projects yet</h2>
              <p className="text-base-content/70">
                A project holds one property: its photos, voice walkthrough, and listing pack.
                Creating projects is coming soon.
              </p>
            </div>
          </div>
        </div>
      </main>
    </>
  );
};

ProjectsPage.auth = 'required';

export default ProjectsPage;
