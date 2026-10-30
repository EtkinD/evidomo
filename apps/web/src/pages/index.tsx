import Head from 'next/head';
import { LandingPage } from '../components/landing/LandingPage';

const TITLE = 'Evidomo: listing packs where every claim has a source';
const DESCRIPTION =
  'Photos and a voice walkthrough in, a listing pack out. Every statement links to the form field, spoken turn, or photo it came from, and you review it before export.';

export default function Home() {
  return (
    <>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta key="og:title" property="og:title" content={TITLE} />
        <meta key="og:description" property="og:description" content={DESCRIPTION} />
      </Head>
      <LandingPage />
    </>
  );
}
