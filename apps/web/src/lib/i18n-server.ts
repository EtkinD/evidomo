// Server-side only: the page functions that read a locale's message file. Each page re-exports
// one of them, and Next removes `getStaticProps` and `getServerSideProps` (and with them this
// module's imports) from the browser bundle, so no catalogue ships with the page code.
import type { GetServerSideProps, GetStaticProps } from 'next';
import { resolveLocale, type Messages } from './i18n';

/** Loads one locale's messages. Each file is its own chunk, so a page ships only the active one. */
export async function loadMessages(locale: unknown): Promise<Messages> {
  const resolved = resolveLocale(locale);
  const catalogue = (await import(`../../messages/${resolved}.json`)) as { default: Messages };
  return catalogue.default;
}

export interface MessagesProps {
  messages: Messages;
}

/**
 * Static pages: the messages are baked into each locale's HTML at build time, so the pages stay
 * statically optimised (a `getInitialProps` in `_app` would turn every page into a per-request
 * render). Re-exported as `getStaticProps` by each page.
 */
export const getStaticProps: GetStaticProps<MessagesProps> = async ({ locale }) => ({
  props: { messages: await loadMessages(locale) },
});

/**
 * Dynamic routes (`/runs/[runId]`, ...): `getStaticProps` would need `getStaticPaths` and cache one
 * HTML file per id and locale, growing without bound with whatever ids visitors request. The pages
 * fetch everything client-side, so a per-request render that only reads a bundled JSON file is the
 * cheaper choice. No database or secret is touched.
 */
export const getServerSideProps: GetServerSideProps<MessagesProps> = async ({ locale }) => ({
  props: { messages: await loadMessages(locale) },
});
