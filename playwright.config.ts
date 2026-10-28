import { defineConfig, devices } from '@playwright/test';

// E2E_BASE_URL points the suite at an already running deployment (e.g. production smoke tests);
// without it, Playwright starts the local web dev server.
const externalBaseUrl = process.env['E2E_BASE_URL'];
const localBaseUrl = 'http://localhost:3000';

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
        webServer: {
          command: 'npm run dev:web',
          url: localBaseUrl,
          reuseExistingServer: !process.env['CI'],
          timeout: 120_000,
        },
      }),
});
