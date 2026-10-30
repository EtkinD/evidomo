import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// E2E_BASE_URL points the suite at an already running deployment (e.g. production smoke tests);
// without it, Playwright starts the local stack: the API and the web dev server, which proxies
// /api to the API (apps/web/next.config.ts). The API needs a migrated PostgreSQL.
//
// Two local modes:
// - default (`npm run test:e2e`): web :3000, API :4000, the `evidomo` development database,
//   reusing servers that already run there (`npm run db:up && npm run db:migrate` first).
// - isolated (`npm run test:e2e:isolated`, E2E_ISOLATED=1): web :3100, API :4100, the dedicated
//   `evidomo_e2e` database (created and migrated by e2e/support/prepare-isolated.ts) and a
//   throwaway storage directory. It never reuses a server, so it runs next to a developer's own
//   servers and cannot touch their data. E2E_WEB_PORT, E2E_API_PORT, and E2E_DATABASE_URL override.
const externalBaseUrl = process.env['E2E_BASE_URL'];
const isolated = process.env['E2E_ISOLATED'] === '1';
const webPort = process.env['E2E_WEB_PORT'] ?? (isolated ? '3100' : '3000');
const apiPort = process.env['E2E_API_PORT'] ?? (isolated ? '4100' : '4000');
const localBaseUrl = `http://localhost:${webPort}`;
const localApiOrigin = `http://localhost:${apiPort}`;
// The local development database from docker-compose.yml (not a secret).
const localDatabaseUrl =
  process.env['E2E_DATABASE_URL'] ??
  `postgres://evidomo:evidomo@localhost:5432/${isolated ? 'evidomo_e2e' : 'evidomo'}`;
// Shared with e2e/support/prepare-isolated.ts, which recreates it.
const isolatedStorageDir = path.join(os.tmpdir(), 'evidomo-e2e-storage');
const reuseExistingServer = !isolated && !process.env['CI'];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: externalBaseUrl ?? localBaseUrl,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(externalBaseUrl
    ? {}
    : {
        webServer: [
          {
            // `start`, not `dev`: no file watching and no repository .env file; everything the
            // API needs is passed here.
            command: 'npm run start -w @evidomo/api',
            url: `${localApiOrigin}/api/healthz`,
            reuseExistingServer,
            timeout: 60_000,
            gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
            env: {
              NODE_ENV: 'development',
              PORT: apiPort,
              LOG_LEVEL: 'warn',
              DATABASE_URL: localDatabaseUrl,
              APP_ORIGIN: localBaseUrl,
              // Auth flows make no model calls; never hand a real key to the test stack.
              MODEL_API_KEY: '',
              ...(isolated ? { STORAGE_DIR: isolatedStorageDir } : {}),
            },
          },
          {
            // `dev:web` hard-codes --port 3000, and Next locks its dist directory per running dev
            // server, so the isolated stack runs `next dev` itself with its own port and dist dir.
            command: isolated
              ? `npm exec --workspace @evidomo/web -- next dev --port ${webPort}`
              : 'npm run dev:web',
            url: localBaseUrl,
            reuseExistingServer,
            timeout: 120_000,
            env: {
              API_PROXY_ORIGIN: localApiOrigin,
              ...(isolated ? { NEXT_DIST_DIR: '.next-e2e' } : {}),
            },
          },
        ],
      }),
});
