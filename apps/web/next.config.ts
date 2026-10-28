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

export default function nextConfig(phase: string): NextConfig {
  return {
    reactStrictMode: true,
    poweredByHeader: false,
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
