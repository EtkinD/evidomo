# Tasks

Status: Draft — under founder review
Companions: [roadmap.md](./roadmap.md), [architecture.md](./architecture.md), [product.md](./product.md)

Format: `ID — title`, with **Depends on** and **Done when** as sub-items. Every task also meets the definition of done in roadmap.md §5. Check a box when its "Done when" is demonstrably true.

## Owners

The orchestrator (main session) delegates each task to its owner — see `.claude/agents/`. Tasks marked "user" need the founder (accounts, servers, recording).

| Tasks                             | Owner                                                                 |
| --------------------------------- | --------------------------------------------------------------------- |
| P0-01 … P0-10                     | orchestrator                                                          |
| P1-01 … P1-08                     | ai-pipeline-engineer                                                  |
| P2-01, P2-03, P2-04, P2-05, P2-10 | backend-developer                                                     |
| P2-02, P2-06 … P2-09              | ai-pipeline-engineer                                                  |
| P3-01 … P3-07, P3-10              | ai-pipeline-engineer                                                  |
| P3-08, P3-09                      | backend-developer                                                     |
| P4-01                             | backend-developer (API), then frontend-developer (UI)                 |
| P4-02 … P4-09                     | frontend-developer — any new endpoint goes to backend-developer first |
| P4-10                             | backend-developer                                                     |
| P4B-01                            | ai-pipeline-engineer (Muse assets), then frontend-developer           |
| P4B-02 … P4B-06                   | frontend-developer                                                    |
| D-01, D-05, D-06                  | devops-engineer                                                       |
| D-02 … D-04                       | devops-engineer prepares, user executes (VPS, DNS, secrets)           |
| P5-01                             | ai-pipeline-engineer                                                  |
| P5-02, P5-06                      | orchestrator with the user                                            |
| P5-03, P5-05                      | frontend-developer                                                    |
| P5-04                             | backend-developer                                                     |
| P6-01                             | orchestrator                                                          |
| P6-02, P6-03                      | user (orchestrator prepares)                                          |

## Phase 0 — Foundation

- [x] **P0-01 — Monorepo scaffold**
  - Depends on: —
  - Done when: npm workspaces (`apps/web`, `apps/api`, `packages/shared`) exist; root `tsconfig` has `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`; Node LTS pinned (`.nvmrc` + `engines`); `npm install` and `npm run typecheck` pass on a clean clone.
- [x] **P0-02 — Lint and format**
  - Depends on: P0-01
  - Done when: shared ESLint + Prettier config; `npm run lint` and `npm run format:check` pass across all workspaces.
- [x] **P0-03 — Web app skeleton**
  - Depends on: P0-01
  - Done when: Next.js (Pages Router) with Tailwind CSS + daisyUI renders a themed placeholder page; no API routes exist.
- [x] **P0-04 — API and worker skeleton**
  - Depends on: P0-01
  - Done when: Express 5 server with zod-validated env, pino logging, and `GET /api/healthz`; a worker entrypoint starts pg-boss; both run locally against Docker PostgreSQL.
- [x] **P0-05 — Database tooling**
  - Depends on: P0-04
  - Done when: local `docker-compose` PostgreSQL; Drizzle config; `npm run db:generate` and `npm run db:migrate` run successfully against the local database (the schema stays empty until P2-01 adds the first tables).
- [x] **P0-06 — Unit and integration test setup**
  - Depends on: P0-03, P0-05
  - Done when: Vitest runs for web (React Testing Library + happy-dom), api (Supertest), and shared; one Testcontainers PostgreSQL integration test passes; `npm test` is green.
- [x] **P0-07 — E2E setup**
  - Depends on: P0-03
  - Done when: Playwright installed with one smoke test (home page loads); `npm run test:e2e` passes locally.
- [x] **P0-08 — CI**
  - Depends on: P0-02, P0-06
  - Done when: a GitHub Actions workflow runs lint, format, typecheck, unit and integration tests on push and PR, plus a dependency audit job (also scheduled daily), and is green.
- [x] **P0-09 — Repository hygiene**
  - Depends on: P0-01
  - Done when: `.gitignore` covers env files, uploads, and local data; `.env.example` lists every variable; project `CLAUDE.md` documents commands, conventions, and branch/version strategy; README skeleton states the hackathon build window; `docs/` contains the public docs; Apache-2.0 `LICENSE` at the root.
- [x] **P0-10 — Public repository**
  - Depends on: P0-09
  - Done when: the GitHub repository is public, contains the pushed history, GitHub detects the Apache-2.0 license, and CI runs on the default branch.

## Phase 1 — Model spikes

- [x] **P1-01 — Meta client module**
  - Depends on: P0-04, P0-06
  - Done when: AI SDK provider and `openai` client are configured for `https://api.meta.ai/v1` with SDK-level retries and timeouts (no duplicate retry layer); usage capture interface; MSW-based record/replay switch (`RECORD=1`) works for both SDKs; one Spark call recorded and replayed in a test.
- [x] **P1-02 — Spark 1.3: text, vision, structured output**
  - Depends on: P1-01
  - Done when: fixtures exist for a text call, a single-photo vision call, and a zod-schema structured-output call; notes confirm which reasoning-effort values pass through AI SDK provider options and where reasoning tokens appear in usage.
- [x] **P1-03 — Wonder 1.0: cost and latency**
  - Depends on: P1-02
  - Done when: a reconciliation-sized prompt is run at low/medium/high effort; latency, reasoning tokens, and cost are recorded; per-step model and effort defaults are decided and written to architecture.md.
- [x] **P1-04 — Voice Transcribe**
  - Depends on: P1-01
  - Done when: ffmpeg converts m4a/webm to 16 kHz mono 16-bit PCM WAV; a 2–5 minute Dutch sample is transcribed with keyword biasing through the `openai` SDK's custom request (native `fetch` only if the SDK cannot send the multipart body — documented in model notes); turns with `startMs`/`endMs` are parsed into typed objects; fixture recorded.
- [x] **P1-05 — SAM 3.1 and output parser**
  - Depends on: P1-01
  - Done when: text-prompt segmentation works via the Responses API through the AI SDK (or the `openai` SDK's `responses.create` if the AI SDK alters the special-token output); the special-token output parser returns typed boxes and masks and is unit-tested on recorded output; a mask overlay renders to PNG for visual inspection.
- [x] **P1-06 — Muse Image edits**
  - Depends on: P1-01
  - Done when: five declared-operation edits of interior photos are recorded (via the AI SDK image API if it reaches `/v1/images/edits`, otherwise the `openai` SDK's `images.edit`); output dimensions vs. input are documented.
- [x] **P1-07 — Integrity check feasibility**
  - Depends on: P1-05, P1-06
  - Done when: for the five edits plus one deliberately structure-altering edit, window/door/radiator counts and bounding-box IoU are compared after resizing; a decision is recorded — GO (threshold chosen), FALLBACK (declutter/object removal only), or DROP.
- [x] **P1-08 — Model notes**
  - Depends on: P1-02 … P1-07
  - Done when: `docs/model-notes.md` records request/response shapes, constraints found, measured costs, and decisions; the cost table in architecture.md is updated with measured values.

## Phase 2 — Run engine and intake

- [x] **P2-01 — Data model**
  - Depends on: P0-05
  - Done when: Drizzle schema and migrations for users, sessions, projects, materials, runs, run_events, facts, artifacts, claims, decisions, usage_ledger; repository functions have integration tests.
- [x] **P2-02 — Definition and market profile loader**
  - Depends on: P0-01
  - Done when: `listing-launch.v1`, `international.v1`, and `nl.v1` load and validate with zod at startup; an invalid definition fails fast with a clear error (tested).
- [x] **P2-03 — Run state machine on pg-boss**
  - Depends on: P2-01, P2-02
  - Done when: steps run as jobs with idempotency keys; state change and enqueue are transactional; gates pause runs; an integration test kills the worker mid-run, restarts it, and the run completes without re-executing completed steps.
- [x] **P2-04 — Usage ledger and budget caps**
  - Depends on: P1-01, P2-01
  - Done when: each model call records units and estimated cost from the shared price table; per-run and global daily caps stop work with an explicit error (tested with fake prices).
- [x] **P2-05 — Upload processing**
  - Depends on: P2-01
  - Done when: images are validated, downscaled, re-encoded with all metadata removed (test asserts no GPS EXIF); audio is validated and converted to WAV; files are stored through the storage interface.
- [x] **P2-06 — Step: intake**
  - Depends on: P1-04, P2-03, P2-05
  - Done when: the transcript is stored as turns with timestamps; keyword list is built from the fact form and market profile.
- [x] **P2-07 — Step: fact extraction**
  - Depends on: P1-02, P2-06
  - Done when: candidate facts are extracted with structured output; each has provenance (form field or transcript turn).
- [x] **P2-08 — Step: vision inventory**
  - Depends on: P1-02, P1-05, P2-03
  - Done when: each photo has room/subject, quality, and cover rank; privacy masks exist for people and license plates; evidence masks stay within the configured cap.
- [x] **P2-09 — Step: reconciliation**
  - Depends on: P1-03, P2-07, P2-08
  - Done when: a Verified Fact Sheet and conflict list are produced; areas are compared as value + unit + basis (different bases are not reported as contradictions; same basis with different values is); Spark fallback works when Wonder fails.
- [x] **P2-10 — Gate 1 API**
  - Depends on: P2-09
  - Done when: conflicts can be listed and resolved through the API; the run resumes after all are decided; covered by a fixture-based integration test.

## Phase 3 — Generation, verification, export

- [x] **P3-01 — Step: creative copy**
  - Depends on: P2-10
  - Done when: portal and social variants are produced in the selected output language as `{ text, fact_ids[] }` segments, using the office tone.
- [x] **P3-02 — Claim validator**
  - Depends on: P3-01
  - Done when: segments with empty or unknown fact IDs are rejected; numbers in text must exactly match the cited facts; unit tests cover pass and fail cases.
- [x] **P3-03 — Buyer Q&A cards**
  - Depends on: P3-02
  - Done when: Q&A cards are generated from verified facts only and pass the claim validator.
- [x] **P3-04 — Staging variants**
  - Depends on: P1-07, P2-08
  - Done when: declared-operation edits are produced per the P1-07 decision; every staged image is labeled and linked to its original.
- [x] **P3-05 — Step: integrity check**
  - Depends on: P1-07, P3-04
  - Done when: the check passes valid edits and rejects the structure-altering test edit; one retry then fallback to the original.
- [x] **P3-06 — Step: verification**
  - Depends on: P3-02
  - Done when: the rubric covers claim support, superlatives and promises, exclusionary phrasing, and market-profile rules; up to two revision loops; remaining flags are stored for Gate 2.
- [x] **P3-07 — Publication checklist**
  - Depends on: P2-02, P3-06
  - Done when: checklist items are evaluated from the market profile (e.g., energy label present, staging disclosed) and shown in the pack.
- [x] **P3-08 — Gate 2 API**
  - Depends on: P3-05, P3-06
  - Done when: each flag can be approved, edited, or removed and each staged image approved or rejected through the API; export is blocked until all are decided.
- [x] **P3-09 — Export**
  - Depends on: P3-08
  - Done when: a print-ready HTML pack and portal-fields JSON (schema in `packages/shared`) are produced deterministically from stored artifacts; exported images have faces/plates blurred.
- [x] **P3-10 — Headless pipeline CLI**
  - Depends on: P3-09
  - Done when: `npm run pipeline -- <project-dir>` runs the whole flow with scripted gate decisions, against live API or fixtures; in fixture mode it makes zero model calls.

## Phase 4 — Web application

- [x] **P4-01 — Auth**
  - Depends on: P2-01
  - Done when: register, login, logout with argon2 and httpOnly cookie sessions; protected routes redirect to login.
- [x] **P4-02 — Project creation**
  - Depends on: P4-01
  - Done when: a project is created with office profile, market profile, and output language.
- [x] **P4-03 — Mobile capture**
  - Depends on: P4-02, P2-05
  - Done when: on a phone, photos can be taken or picked (downscaled client-side) and a voice walkthrough recorded in the browser and uploaded; layout works at phone width.
- [x] **P4-04 — Fact form**
  - Depends on: P2-02, P4-02
  - Done when: the form is generated from the market profile schema with validation and required fields.
- [x] **P4-05 — Run monitor**
  - Depends on: P2-03
  - Done when: step progress and running cost update live over SSE.
- [x] **P4-06 — Gate 1 UI**
  - Depends on: P2-10, P4-05
  - Done when: each conflict shows both values with their evidence (form value, transcript turn with audio playback, photo) and can be resolved in one action.
- [x] **P4-07 — Review workspace (Gate 2)**
  - Depends on: P3-08, P4-05
  - Done when: flagged claims can be approved/edited/removed; clicking any claim shows its evidence (form field, transcript turn, or photo with mask overlay); staged images are compared side by side with originals.
- [x] **P4-08 — Pack viewer and export**
  - Depends on: P3-09
  - Done when: the pack renders in the browser, prints cleanly to PDF, and the JSON downloads.
- [ ] **P4-09 — Demo replay mode**
  - Depends on: P4-05 … P4-08
  - Done when: a stored completed run replays from `run_events` with original timing at a public URL, without login and without model calls.
- [x] **P4-10 — Live-run access control**
  - Depends on: P4-01, P2-04
  - Done when: starting a live run requires an access code; per-IP and per-account rate limits apply; the global daily cap is enforced.

## Phase 4b — Product UI and brand

Design decisions are made in a dev-only showcase, and only what the founder approves there enters the design language (recorded in the `evidomo-theme` skill). Model-generated images are made with Muse Image tools off (no image or web search), so no third-party content enters the repository.

- [x] **P4B-01 — Design showcase**
  - Depends on: —
  - Done when: a `/showcase` area that exists only on the dev server (absent from production builds) presents three design directions across sub-pages for colour palettes, typography, logo, UI elements, and imagery/landing drafts, light and dark; Muse concept images are generated with tools off within the phase budget; exploration assets stay out of git.
- [x] **P4B-02 — Design language decision**
  - Depends on: P4B-01
  - Done when: the founder's showcase feedback is recorded in the `evidomo-theme` decision log, the chosen palette and typography are the `evidomo-light`/`evidomo-dark` tokens (contrast check passes), and the showcase's rejected candidates are removed.
- [ ] **P4B-03 — Logo and brand assets**
  - Depends on: P4B-02
  - Done when: the chosen logo exists as SVG (mark and wordmark, light and dark), with favicon, app icons, and an Open Graph image; it is used in the app shell and the HTML pack.
- [ ] **P4B-04 — App shell**
  - Depends on: P4B-02
  - Done when: header with logo and navigation, account menu, footer, and a light/dark theme switch work at phone and desktop widths.
- [ ] **P4B-05 — Landing page**
  - Depends on: P4B-03, P4B-04
  - Done when: the public home page explains the product (capture → verify → pack, evidence for every claim), shows approved imagery, and links to sign-up and to the public demo (P4-09).
- [ ] **P4B-06 — App screen polish**
  - Depends on: P4B-02
  - Done when: projects, project, capture, run monitor (readable step names), gates, and pack screens follow the chosen language, with designed empty, loading, and error states.

## Track D — Deployment

- [x] **D-01 — Production images and compose**
  - Depends on: P0-04, P0-03
  - Done when: production Dockerfiles (API/worker image includes ffmpeg) and a compose file with caddy, web, api, worker, postgres, healthchecks, and volumes run locally.
- [ ] **D-02 — VPS provisioning**
  - Depends on: D-01
  - Done when: a Linode VPS in an EU region runs Ubuntu with Docker, firewall limited to 22/80/443, and a non-root deploy user.
- [ ] **D-03 — Domain and HTTPS**
  - Depends on: D-02
  - Done when: the Squarespace domain's DNS points to the VPS and Caddy serves valid HTTPS.
- [ ] **D-04 — Secrets**
  - Depends on: D-02
  - Done when: the server `.env` has mode 600, is not in the repository, and `MODEL_API_KEY` is only available to api and worker.
- [ ] **D-05 — Deploy script and backups**
  - Depends on: D-03, D-04
  - Done when: one script pulls, builds, migrates, restarts, and runs a smoke check; a daily `pg_dump` is written to a volume.
- [ ] **D-06 — Production smoke test**
  - Depends on: D-05, P0-07
  - Done when: the Playwright smoke suite passes against the production URL.

## Phase 5 — Hardening and evaluation

- [ ] **P5-01 — Seeded-defect eval**
  - Depends on: P3-10
  - Done when: `npm run eval` runs seeded property sets (planted conflicts and unsupported claims) and reports catch rate, in fixture mode by default and live mode on demand.
- [ ] **P5-02 — Second property**
  - Depends on: P4-08, D-05
  - Done when: a second real property completes end to end on production; issues found are fixed or documented.
- [ ] **P5-03 — Failure UX**
  - Depends on: P4-05
  - Done when: failed steps, resumes, and budget-exceeded states are clearly shown and recoverable from the UI.
- [ ] **P5-04 — Project deletion**
  - Depends on: P2-01, P2-05
  - Done when: deleting a project hard-deletes materials, artifacts, and derived data (tested).
- [ ] **P5-05 — E2E flow**
  - Depends on: P4-09
  - Done when: Playwright covers capture → run → Gate 1 → Gate 2 → export against the stack in fixture mode.
- [ ] **P5-06 — Demo run**
  - Depends on: P5-02, P4-09
  - Done when: the demo property's run is recorded as the public replay and verified on production.

## Phase 6 — Release

- [ ] **P6-01 — README**
  - Depends on: P5-01
  - Done when: README covers what the product does, that it was built during the hackathon (Oct 26 – Nov 4, 2026), architecture overview, Meta models used per step, eval results, setup instructions, and license.
- [ ] **P6-02 — Demo video**
  - Depends on: P5-06
  - Done when: the 3-minute demo video is recorded and published, and the link opens without login.
- [ ] **P6-03 — Submission**
  - Depends on: P6-01, P6-02
  - Done when: the project is submitted and every submitted link has been verified in a private browser window.
