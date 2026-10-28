import Head from 'next/head';

export default function Home() {
  return (
    <>
      <Head>
        <title>Evidomo — evidence for every home</title>
        <meta
          name="description"
          content="Verified, source-linked listing packs for real estate agents."
        />
      </Head>
      <main className="hero min-h-screen bg-base-200">
        <div className="hero-content max-w-xl text-center">
          <div>
            <h1 className="text-5xl font-bold">Evidomo</h1>
            <p className="py-6 text-lg">
              Evidence for every home. Raw photos and a voice walkthrough in, a verified listing
              pack out — every claim linked to its source.
            </p>
            <span className="badge badge-outline">In development</span>
          </div>
        </div>
      </main>
    </>
  );
}
