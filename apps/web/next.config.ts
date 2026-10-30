import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

const DEFAULT_API_PROXY_ORIGIN = 'http://localhost:4000';

// The API's origin for the dev proxy. Server-side only (not NEXT_PUBLIC_), read when the dev
// server starts.
function apiProxyOrigin(): string {
  const raw = process.env['API_PROXY_ORIGIN'] || DEFAULT_API_PROXY_ORIGIN;
  const url = URL.parse(raw);
  if (
    url === null ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`API_PROXY_ORIGIN must be a bare http(s) origin, got "${raw}"`);
  }
  return url.origin;
}

const DEFAULT_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'];

// `*.dev.mts` files under src/pages are routes only on the dev server (the design showcase).
// The extension deliberately does not end in `.ts`/`.tsx`: Next matches `index.dev.tsx` against
// the `tsx` extension and would build it as the route `/index.dev` in production. In a production
// build the file is not a page, so it is never compiled or bundled.
export function pageExtensionsFor(phase: string): string[] {
  return phase === PHASE_DEVELOPMENT_SERVER
    ? [...DEFAULT_PAGE_EXTENSIONS, 'dev.mts']
    : DEFAULT_PAGE_EXTENSIONS;
}

// The showcase's utility stylesheet (src/styles/showcase.css) is global CSS, which Next only
// accepts from `_app`. `_app` imports the `showcase-styles` alias; production builds resolve it to
// an empty file, so none of the showcase CSS is emitted.
export function showcaseStylesFor(phase: string): string {
  return phase === PHASE_DEVELOPMENT_SERVER
    ? './src/styles/showcase.css'
    : './src/styles/showcase-off.css';
}

export default function nextConfig(phase: string): NextConfig {
  return {
    reactStrictMode: true,
    poweredByHeader: false,
    // Isolated e2e runs a second dev server next to the developer's own; Next locks the dist
    // directory per dev server, so that stack builds elsewhere (playwright.config.ts).
    ...(process.env['NEXT_DIST_DIR'] ? { distDir: process.env['NEXT_DIST_DIR'] } : {}),
    pageExtensions: pageExtensionsFor(phase),
    turbopack: { resolveAlias: { 'showcase-styles': showcaseStylesFor(phase) } },
    // @evidomo/shared ships raw TypeScript (no build step). Listing it makes Next compile it and
    // bundle it into the routes, so the production image needs no shared sources at runtime.
    transpilePackages: ['@evidomo/shared'],
    // Development only: the browser stays on the web origin (the API's default APP_ORIGIN,
    // http://localhost:3000), so the session cookie is first-party and the API's Origin check
    // passes. In production Caddy serves web and API on one origin (infra/caddy/Caddyfile), so
    // builds carry no rewrite.
    ...(phase === PHASE_DEVELOPMENT_SERVER
      ? {
          rewrites: () => [
            { source: '/api/:path*', destination: `${apiProxyOrigin()}/api/:path*` },
          ],
        }
      : {}),
  };
}
