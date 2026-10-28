# Evidomo

**Evidence for every home.**

Evidomo turns a real estate agent's raw property photos and voice walkthrough into a verified, publication-ready listing pack — in the buyer's language, with every factual claim linked to the evidence it came from: a form field, a moment in the recording, or a region of a photo.

> **Hackathon project.** Evidomo is being built from scratch during the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (October 26 – November 4, 2026). All code in this repository was written during the event.

## Status

Phase 0 (foundation) of the [roadmap](docs/roadmap.md). The product pipeline is not implemented yet.

## How it works (planned)

1. **Capture** photos and a voice walkthrough on site, from a phone.
2. **Extract and reconcile** facts from the recording, the photos, and a structured fact form; contradictions stop the run until the agent decides.
3. **Generate and verify** listing copy, buyer Q&A, and virtual staging; a code-level validator rejects any claim without a source, and staging edits must pass a structural integrity check.
4. **Export** a print-ready listing pack and portal-ready JSON.

Meta models planned per step: Muse Voice Transcribe (timestamped transcription), Muse Spark (extraction, vision, generation), Muse Wonder (reconciliation and verification), SAM 3.1 (privacy masks, evidence regions, integrity check), Muse Image (virtual staging). Details: [architecture](docs/architecture.md).

## Documentation

- [Product definition](docs/product.md)
- [Architecture](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Tasks](docs/tasks.md)

## Getting started

Prerequisites: Node.js ≥ 24.12 (see `.nvmrc`), npm, Docker.

```sh
npm ci
cp .env.example .env
npm run db:up        # local PostgreSQL via Docker Compose
npm run db:migrate

npm run dev:api      # http://localhost:4000/api/healthz
npm run dev:worker
npm run dev:web      # http://localhost:3000
```

## Scripts

| Command                                  | Purpose                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                           | ESLint (type-aware for TypeScript)                                                                                          |
| `npm run format` / `format:check`        | Prettier                                                                                                                    |
| `npm run typecheck`                      | `tsc` for all workspaces                                                                                                    |
| `npm test`                               | All Vitest projects (unit + integration; integration tests start PostgreSQL with Testcontainers, so Docker must be running) |
| `npm run test:unit` / `test:integration` | One test level only                                                                                                         |
| `npm run test:e2e`                       | Playwright (run `npx playwright install chromium` once first)                                                               |
| `npm run build`                          | Production build of the web app                                                                                             |
| `npm run db:generate` / `db:migrate`     | Drizzle migrations                                                                                                          |

## Repository layout

```
apps/web         Next.js (Pages Router) frontend
apps/api         Express API and pg-boss worker
packages/shared  Shared zod schemas and types
e2e/             Playwright tests
docs/            Product and engineering docs
```

## License

[Apache-2.0](LICENSE)
