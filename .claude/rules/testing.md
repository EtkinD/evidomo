---
paths:
  - '**/*.test.ts'
  - '**/*.test.tsx'
  - 'e2e/**'
  - 'vitest.config.ts'
  - 'playwright.config.ts'
---

# Tests

- Vitest projects: `shared`, `api` (unit), `api-integration`, `web`. Run the narrowest one first: `npx vitest run --project <name>`.
- Unit tests are `*.test.ts(x)`. Integration tests are `*.integration.test.ts`; they use a real PostgreSQL through Testcontainers — do not mock the database in them.
- Meta API calls are served from recorded fixtures through MSW. A test must never make a live model call.
- Test behavior through public interfaces. Query the UI by role and accessible name, in both React Testing Library and Playwright.
- Never weaken, skip, or delete a test to get green checks. If a test is wrong, explain why and fix the test deliberately.
