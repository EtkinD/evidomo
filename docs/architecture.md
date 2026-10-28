# Architecture

Status: Draft — under founder review
Companion: [product.md](./product.md)

## 1. Design principles

1. **The product is the run pipeline.** Engineering effort goes to the pipeline, provenance, and verification; the UI exists to run the pipeline and review its output.
2. **Declarative definitions.** The listing launch service and each market profile are versioned, schema-validated definition files. A new market is a new profile; a new service is a new definition.
3. **Deterministic where possible, models where necessary.** State transitions, claim-source validation, number checks, exports, and cost accounting are plain code. Models do perception, extraction, generation, and judgment.
4. **Measure, don't trust.** Every model call is logged with model ID, usage, latency, and estimated cost. Model behavior is checked by a seeded-defect evaluation set, not assumed.
5. **Human gates are state-machine states.** A run cannot advance past a gate without a recorded human decision.
6. **Standard mode only** for all calls that carry customer content; `-contributor` model variants are never used.
7. **Libraries before hand-rolled code.** When an established, well-maintained library solves a specific job, use it instead of writing raw HTTP or utility code. Native `fetch` or custom code is chosen only when the library would be disproportionately heavy (install size, runtime cost, transitive dependencies) for that job. Every dependency has one stated purpose.

## 2. Stack

| Layer            | Choice                                                                                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language/runtime | TypeScript 6.0 (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`; pinned to `~6.0` because typescript-eslint does not support TypeScript 7 yet), Node.js 24 LTS (≥ 24.12), npm workspaces. API, worker, and shared code run on Node's native TypeScript type stripping — no build step and no runtime transpiler |
| Web              | Next.js **Pages Router**, frontend only (no API routes); Tailwind CSS + daisyUI; TanStack Query                                                                                                                                                                                                                            |
| API              | Express 5, zod validation, Server-Sent Events for run progress, pino logging, express-rate-limit                                                                                                                                                                                                                           |
| Worker           | Separate Node process from the same codebase, consuming pg-boss jobs                                                                                                                                                                                                                                                       |
| Database         | PostgreSQL, Drizzle ORM + drizzle-kit migrations, `pg` driver                                                                                                                                                                                                                                                              |
| Queue            | pg-boss (Postgres-backed); no Redis                                                                                                                                                                                                                                                                                        |
| AI               | Vercel AI SDK (`ai` + `@ai-sdk/openai`, base URL `https://api.meta.ai/v1`) as the primary client; the official `openai` npm package for capabilities the AI SDK does not cover (see §4)                                                                                                                                    |
| Media            | sharp (resize, metadata strip, re-encode, blur, image alignment), ffmpeg (audio → WAV)                                                                                                                                                                                                                                     |
| Storage          | Local filesystem on a Docker volume, behind a storage interface                                                                                                                                                                                                                                                            |
| Auth             | Email + password (argon2), httpOnly cookie sessions stored in Postgres                                                                                                                                                                                                                                                     |
| Testing          | Vitest (unit + integration, web and api), React Testing Library + happy-dom, Supertest, Testcontainers (PostgreSQL), MSW (Meta API record/replay), Playwright (e2e)                                                                                                                                                        |
| Code quality     | ESLint + Prettier, `tsc --noEmit`                                                                                                                                                                                                                                                                                          |
| CI               | GitHub Actions: lint, format, typecheck, unit and integration tests on push/PR; a security job (`npm audit`, moderate and above fail, plus registry signatures) on every push/PR and daily. Installs use `npm ci --ignore-scripts`. No CD.                                                                                 |
| Deployment       | One Linode VPS in an EU region, Docker Compose (caddy, web, api, worker, postgres), Caddy automatic HTTPS, domain DNS at Squarespace                                                                                                                                                                                       |
| License          | Apache-2.0                                                                                                                                                                                                                                                                                                                 |

## 3. Repository layout

```
apps/
  web/            Next.js (Pages Router) frontend
  api/            Express server (src/server.ts) and worker (src/worker.ts)
packages/
  shared/         zod schemas, shared types, price table
definitions/
  services/       listing-launch.v1.yaml
  markets/        international.v1.yaml, nl.v1.yaml
fixtures/meta/    recorded Meta API responses (no personal data)
e2e/              Playwright tests
infra/            production compose file, Caddyfile, deploy script
docs/
.claude/           Claude Code agents, skills, path-scoped rules, hooks
docker-compose.yml  local development services (PostgreSQL)
```

Consequences of native type stripping for `apps/api` and `packages/shared`: only erasable TypeScript syntax (no `enum`, no parameter properties, no namespaces with runtime code), relative imports carry the `.ts` extension, type-only imports use `import type`, and tsconfig `paths` aliases are not available. The web app uses bundler resolution and is unaffected.

Pages Router treats every file under `apps/web/src/pages` as a route, so web tests live in `apps/web/src/__tests__`.

Caddy routes `/api/*` to the API and everything else to the web app on the same domain, so cookies stay same-site and no CORS configuration is needed.

## 4. Meta Model API integration

All model access goes through one `meta` module in `apps/api/src/meta`: client configuration, timeouts, usage capture into the ledger, and the record/replay switch used by tests. Retries (exponential backoff on 429/5xx, honoring `Retry-After`) use the SDKs' built-in retry settings; the module does not add a second retry layer on top. Both SDKs call the API over `fetch`, so MSW record/replay works the same for either.

Module interface (P1-01; details and measured shapes in [model-notes.md](./model-notes.md#p1-01--meta-client-module)):

- `createMetaClients({ apiKey, usage, estimateCost?, logger?, maxRetries?, timeoutMs? })` returns the AI SDK provider (`createOpenAI({ name: 'meta' })`, Responses models via `languageModel(id)`), the `openai` client, `aiSdkCallOptions()`, and `captureOpenAIUsage(call)`. The AI SDK has no provider-level retry/timeout settings, so every AI SDK call spreads `...aiSdkCallOptions()` (`maxRetries`, `timeout`, and the `onLanguageModelCallEnd` usage hook). The `openai` timeout is per attempt; the AI SDK timeout covers the whole call including retries.
- A shared fetch wrapper rejects any request whose `model` ends in `-contributor` (principle 6, enforced in code for both SDKs).
- Usage capture: `UsageRecorder.record(entry)` receives model ID, input/cached/output/reasoning tokens, latency, response ID, and `estimatedCostUsd` from a pluggable `CostEstimator`. `record` is synchronous because the AI SDK silently swallows errors thrown by its callbacks; the ledger (P2-04) buffers and persists after the call returns.
- Record/replay (`replay.ts`, test-only): fixtures in `fixtures/meta/<task>/<name>.json`, matched by method, path, and a hash of the normalized body; replay never touches the network and fails loudly on an unmatched request; `RECORD=1` records 2xx responses only and never stores request headers.
- `MODEL_API_KEY` is required at boot in production and optional in development/test (replay tests use a placeholder).

The Vercel AI SDK is the primary client. The official `openai` package fills the gaps where the AI SDK does not reach an endpoint or changes its output. Native `fetch` is a last resort, used only if neither SDK can express a request.

| Model                       | Used for                                                                                            | Client                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `muse-spark-1.3`            | Fact extraction, photo classification, copy and Q&A generation, default fallback for judgment steps | AI SDK (Responses API; structured output via zod)                                                                                      |
| `muse-wonder-1.0`           | Reconciliation and verification judgment (per-step configurable)                                    | AI SDK                                                                                                                                 |
| `muse-voice-transcribe-1.0` | Voice walkthrough transcription (`POST /v1/asr/transcribe`, not an OpenAI-standard endpoint)        | `openai` SDK custom request (`client.post`)                                                                                            |
| `sam-3.1`                   | Privacy masks, evidence regions, structural integrity check                                         | AI SDK (Responses API); `openai` SDK `responses.create` if the AI SDK alters the special-token output. Masks parsed by our own parser. |
| `muse-image-1.0`            | Virtual staging edits                                                                               | `openai` SDK `images.edit` for edits (`/v1/images/edits`) unless the AI SDK image API can target that endpoint                         |

Known API constraints the design depends on (from Meta's docs):

- **Voice Transcribe** file endpoint accepts only mono 16-bit PCM WAV at 16 or 24 kHz, max 32 MB and 10 minutes. Timestamps are turn-level only (`startMs`/`endMs`); there are no word-level timestamps. Keyword biasing is supported. Turn timestamps are the evidence anchors for transcript claims.
- **SAM 3.1** takes one noun phrase per request; several object types mean several requests. Masks come back as special-token text that must be parsed (see the cookbook's `07_sam` recipes). SAM segments; it does not classify — classification is Spark's job.
- **Muse Image** edits do **not** accept a mask. The docs say edits keep the rest of the image intact but do not guarantee pixel preservation, and output dimensions may differ from the input. This is why the integrity check exists — and why its feasibility is verified in Phase 1 before staging is committed to.
- **Reasoning tokens are billed at output rates** ($20/1M on Wonder). Reasoning effort is therefore set per step, not globally.

To verify in Phase 1 against the pinned SDK versions: which SDK covers each endpoint (the client column above is the starting hypothesis), reasoning-effort values accepted through AI SDK provider options (Meta accepts `"minimal"` to `"max"`), structured-output behavior, whether the `openai` SDK's custom request can send the transcription multipart body, and usage fields (including reasoning tokens).

## 5. Run pipeline

| #   | Step             | Model(s)                        | Input → Output                                                                | Notes                                                                                                                                                                                                                  |
| --- | ---------------- | ------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Intake           | Voice Transcribe                | Audio (converted by ffmpeg) → transcript turns with timestamps                | Keyword biasing from the fact form and market profile (street names, room terms).                                                                                                                                      |
| 2   | Fact extraction  | Spark 1.3                       | Transcript + fact form → candidate facts                                      | Structured output validated by zod. Each fact carries provenance: form field or transcript turn.                                                                                                                       |
| 3   | Vision inventory | Spark 1.3 + SAM 3.1             | Photos → per-photo inventory                                                  | Spark: room/subject, quality, cover ranking. SAM: privacy masks (person, license plate) and a capped number of evidence regions for fact-relevant objects.                                                             |
| 4   | Reconciliation   | Wonder 1.0 (fallback Spark 1.3) | Candidate facts + form + photo evidence → Verified Fact Sheet + conflict list | Areas compared as value + unit + basis. Conflicts pause the run at **Gate 1**.                                                                                                                                         |
| 5   | Creative         | Spark 1.3 + Muse Image          | Fact Sheet + inventory → copy variants, Q&A cards, staging variants           | Copy is emitted as claim segments, each with `fact_ids[]`. Staging requests are explicit declared operations (e.g., "add sofa", "remove clutter from table").                                                          |
| 6   | Integrity check  | SAM 3.1 + code                  | Original vs. staged image → pass/fail                                         | Resize to common dimensions; segment fixed elements (windows, doors, radiators); compare counts and bounding-box IoU against a threshold chosen in Phase 1. Fail → one retry; second failure → keep the original only. |
| 7   | Verification     | Wonder 1.0 (fallback Spark 1.3) | Copy + Fact Sheet + rubric + market profile → Claim Audit                     | Checks claim support, superlatives and promises, exclusionary phrasing, profile-specific rules. Max 2 revision loops back to step 5; remaining flags go to **Gate 2**.                                                 |
| 8   | Export           | Code only                       | Approved pack → HTML pack + portal-fields JSON                                | Deterministic and reproducible from stored artifacts. Faces/plates blurred in exported images.                                                                                                                         |

**Gates:** Gate 1 (fact conflicts) after step 4; Gate 2 (claim audit and image approval) after steps 6–7.

## 6. Provenance: "no source, no claim"

1. The creative step receives only the Verified Fact Sheet and must return copy as structured segments: `{ text, fact_ids[] }`.
2. A code-level validator rejects any segment with empty or unknown `fact_ids`, and compares every number in the text to the cited fact exactly. This runs before any model-based verification.
3. The verifier judges semantic support: does the cited fact actually justify this wording?
4. In the UI, clicking a claim shows its evidence: the form field, the transcript turn (with timestamp and audio playback from that point), or the photo with its SAM mask overlay.

## 7. Definition formats (sketches)

Service definition:

```yaml
service:
  id: listing-launch
  version: 1
  inputs:
    - { key: photos, type: image[], min: 10, max: 30, required: true }
    - { key: voice_memo, type: audio, max_seconds: 600, required: true }
    - { key: facts, type: form, schema: from_market_profile, source_of_truth: true }
  steps:
    - { id: intake, agent: intake }
    - { id: fact_extraction, agent: extractor, model: muse-spark-1.3 }
    - { id: vision_inventory, agent: vision, model: muse-spark-1.3, max_evidence_masks: 12 }
    - { id: reconciliation, agent: reconciler, model: muse-wonder-1.0, reasoning_effort: medium,
        fallback_model: muse-spark-1.3, gate_after: fact_conflicts }
    - { id: creative, agent: creative, model: muse-spark-1.3 }
    - { id: integrity, agent: integrity_checker }
    - { id: verification, agent: verifier, model: muse-wonder-1.0, reasoning_effort: medium,
        fallback_model: muse-spark-1.3, max_revision_loops: 2, gate_after: claim_audit }
    - { id: export, agent: exporter }
  budget: { max_cost_usd_per_run: 0.50 }
```

Market profile (Netherlands; values to be verified before encoding):

```yaml
market:
  id: nl
  version: 1
  source_languages: [nl, en]
  default_output_language: en
  units: { area: m2, volume: m3 }
  area_bases: [NEN2580]
  facts:
    - { key: energy_label, type: enum, required: true }
    - { key: living_area, type: area, basis: NEN2580, required: true }
    - { key: volume, type: volume }
    - { key: plot_area, type: area }
    - { key: build_year, type: integer }
    - { key: vve_monthly_contribution, type: money }
    - { key: ground_lease, type: object }
  publication_checklist:
    - { id: energy_label_shown, rule: fact_present(energy_label) }
    - { id: staging_disclosed, rule: all_staged_images_labeled }
  flagged_phrasing: [exclusionary, investment_promise, unverifiable_superlative]
```

## 8. Data model (sketch)

- `users`, `sessions` — single-operator accounts.
- `projects` — one listing job: owner, office profile snapshot, market profile ID + version, output language, status.
- `materials` — uploaded files: type, storage key, hash, processing status.
- `runs` — one execution of a service definition version; states `queued → running → awaiting_gate → completed | failed`; definition and profile versions recorded for reproducibility.
- `run_events` — append-only event log per run (step started/finished, gate opened/decided, cost updates). Drives SSE progress and demo replay.
- `facts` — key, value, unit, measurement basis, provenance (`form | transcript turn | photo region`), status (`candidate | verified | conflicted | rejected`).
- `artifacts` — generated outputs with the model call IDs that produced them.
- `claims` — one row per factual claim in generated copy: text span, artifact, fact IDs, validator result, verifier verdict.
- `decisions` — human gate decisions: gate, choice, edited value, timestamp.
- `usage_ledger` — per model call: model, units (tokens incl. reasoning / audio seconds / images / frames), estimated cost, run.

## 9. Runs, jobs, and reliability

- Each pipeline step is a pg-boss job with an idempotency key (`run_id + step_id + attempt scope`). A completed step is never re-executed or re-billed on retry or restart.
- Run state changes and job enqueues happen in the same database transaction (pg-boss can send through a caller-provided executor — confirm against the pinned version).
- Step timeouts; a step that fails twice marks the run failed in a resumable state.
- If Wonder is unavailable, judgment steps fall back to Spark and the result is labeled as such.

## 10. Cost controls

| Item             | List price (Standard mode)                                       | Per-run expectation                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spark 1.3        | $1.25 in / $4.25 out per 1M tokens                               | Bulk of steps. Measured (P1-01): a 20-token prompt with a one-sentence answer cost ~$0.0024 at the default effort `high` (~95% of output was reasoning), so effort is set per step |
| Wonder 1.0       | $4.00 in / $20.00 out per 1M tokens (reasoning billed as output) | 2 judgment steps; measured in Phase 1                                                                                                                                              |
| Voice Transcribe | $0.18 per audio hour                                             | ~$0.01–0.03                                                                                                                                                                        |
| Muse Image       | $0.01 per image                                                  | ~$0.03–0.06                                                                                                                                                                        |
| SAM 3.1          | $2.50 per 1,000 images                                           | ~$0.05–0.15 (one request per image per noun phrase)                                                                                                                                |

Controls: per-run budget cap (fails the run loudly), global daily budget cap, per-IP and per-account rate limits, an access code for live runs on the public deployment, and a zero-cost demo replay mode. Web search grounding ($2.50 per 1,000 queries) is off by default.

## 11. Demo replay mode

A completed run's `run_events` and artifacts are replayed in the UI with the original timing, without any model calls. Visitors can walk through the whole flow — gates, evidence inspector, exports — without an account. Live runs require login and an access code.

## 12. Testing strategy

| Level       | Tooling                                   | Covers                                                                                                                                                                         |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | Vitest                                    | Claim validator, number matching, area-basis comparison, state machine transitions, cost calculation, SAM output parser, definition/profile validation, React components (RTL) |
| Integration | Vitest + Supertest + Testcontainers + MSW | API routes against a real PostgreSQL; full pipeline runs against recorded Meta API fixtures (no credit spent, deterministic)                                                   |
| E2E         | Playwright                                | Capture → run → gates → export against the stack in replay mode; production smoke test                                                                                         |
| Evaluation  | `npm run eval`                            | Seeded-defect property sets: catch rate for planted conflicts and unsupported claims. Fixture mode is free; live mode is run deliberately and logged.                          |

Fixtures are recorded from real calls in Phase 1 (`RECORD=1`) and must not contain personal data.

## 13. Deployment

- One Linode VPS in an EU region running Docker Compose: `caddy`, `web` (`next start`), `api`, `worker`, `postgres`. The API/worker image includes ffmpeg.
- Caddy terminates HTTPS automatically; the domain's DNS (Squarespace) points to the VPS.
- Firewall allows only 22, 80, 443; deploys run as a non-root user.
- Secrets live in a server-side `.env` (mode 600), never in the repository. `MODEL_API_KEY` is available only to `api` and `worker`, never to the browser.
- Deploy script: pull, build, migrate, restart, smoke test. Daily `pg_dump` to the volume.
- Images are built on the server from the repository (no registry). `apps/api/Dockerfile` builds one image for api and worker (production dependencies, sources run through type stripping, ffmpeg); its `migrate` target adds drizzle-kit for one-off migrations. `apps/web/Dockerfile` builds Next.js and runs `next start`. `infra/caddy/Dockerfile` bakes in the Caddyfile. All run as non-root users.
- `infra/compose.yaml` (project `evidomo-prod`) reads variables from `infra/.env` (template: `infra/.env.example`) and passes each service only what it needs. Caddy's site address comes from `SITE_ADDRESS` (`:80` for local HTTP). PostgreSQL is not published to the host; it sits on a `backend` network with api and worker, while caddy, web, and api share an `edge` network.
- Volumes: `postgres-data`, `storage` (mounted at `/data` in api and worker, exposed as `STORAGE_DIR` for the storage interface), `caddy-data`, `caddy-config`.
- Healthchecks: postgres `pg_isready`, api `GET /api/healthz`, web `GET /`, caddy admin API. The worker has no endpoint; a fatal error exits the process and the restart policy brings it back.
- Migrations: `docker compose -f infra/compose.yaml --env-file infra/.env --profile tools run --rm migrate`.

## 14. Security and privacy

- Uploads validated by type and size; images re-encoded with all metadata (including GPS) removed.
- Faces and license plates blurred in exported images by default.
- Project deletion hard-deletes materials, artifacts, and derived data.
- No customer content is sent to Contributor-mode models or used for training/fine-tuning.
- EU hosting; data minimization by default (GDPR).

## 15. References

Meta model cookbook (`github.com/meta-models/meta-model-cookbook`): `01_api_fundamentals` (structured output, vision, error handling), `02_agent_patterns` (validated in-place edits), `04_muse_code` (staged approvals, append-only audit log, deterministic replay in CI), `05_muse_image`, `06_muse_voice`, `07_sam`.
