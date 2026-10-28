import { defineConfig, devices } from '@playwright/test';

// E2E_BASE_URL points the suite at an already running deployment (e.g. production smoke tests);
// without it, Playwright starts the local stack: the API on :4000 and the web dev server on
// :3000, which proxies /api to the API (apps/web/next.config.ts). The API needs a migrated
// local PostgreSQL: `npm run db:up && npm run db:migrate`.
const externalBaseUrl = process.env['E2E_BASE_URL'];
const localBaseUrl = 'http://localhost:3000';
const localApiOrigin = 'http://localhost:4000';
// The local development database from docker-compose.yml (not a secret).
const localDatabaseUrl =
  process.env['E2E_DATABASE_URL'] ?? 'postgres://evidomo:evidomo@localhost:5432/evidomo';

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
            reuseExistingServer: !process.env['CI'],
            timeout: 60_000,
            gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
            env: {
              NODE_ENV: 'development',
              PORT: '4000',
              LOG_LEVEL: 'warn',
              DATABASE_URL: localDatabaseUrl,
              APP_ORIGIN: localBaseUrl,
              // Auth flows make no model calls; never hand a real key to the test stack.
              MODEL_API_KEY: '',
            },
          },
          {
            command: 'npm run dev:web',
            url: localBaseUrl,
            reuseExistingServer: !process.env['CI'],
            timeout: 120_000,
            env: { API_PROXY_ORIGIN: localApiOrigin },
          },
        ],
      }),
});
