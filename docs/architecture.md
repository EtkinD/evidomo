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
| API              | Express 5, zod validation, Server-Sent Events for run progress, pino logging, express-rate-limit, yaml (strict YAML 1.2 parsing of definition files)                                                                                                                                                                       |
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
  services/       listing-launch.v1.yaml (loaded and validated at boot, §7)
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
- Usage capture: `UsageRecorder.record(entry)` receives model ID, input/cached/output/reasoning tokens, latency, response ID, `estimatedCostUsd` from a pluggable `CostEstimator`, and, for non-token models, `audioDurationMs` (whole milliseconds, Voice) or `images` (Muse Image, SAM). `record` is synchronous because the AI SDK silently swallows errors thrown by its callbacks; the usage ledger (P2-04, §10) buffers and persists after the call returns. `estimatedCostUsd` is a float for display and logs only; the ledger persists an exact decimal computed from the units.
- Record/replay (`replay.ts`, test-only): fixtures in `fixtures/meta/<task>/<name>.json`, matched by method, path, and a hash of the normalized body; replay never touches the network and fails loudly on an unmatched request; `RECORD=1` records 2xx responses only and never stores request headers.
- `MODEL_API_KEY` is required at boot in production and optional in development/test (replay tests use a placeholder).
- Per-call model settings (P1-02; [model-notes.md](./model-notes.md#p1-02--spark-13-text-vision-structured-output)): AI SDK calls pass `providerOptions: metaProviderOptions({ reasoningEffort, store? })`, `openai` SDK calls spread `metaResponsesParams(...)`. The helper exists because `@ai-sdk/openai` reads only the `openai` options key (options under `meta` are dropped silently) and drops `reasoningEffort` for non-OpenAI model IDs unless `forceReasoning: true`. Accepted efforts for Spark and Wonder (P1-03) are `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (`none` is rejected); `metaReasoningEffortSchema` validates definition values. `store` defaults to `false` because steps carry customer content.
- Images (P1-06; [model-notes.md](./model-notes.md#p1-06--muse-image-edits)): `generateMetaImage(clients, { modelId, prompt, size?, outputFormat? })` and `editMetaImage(clients, { ..., images })` in `meta/images.ts` call the AI SDK `generateImage` on `clients.imageModel(id)` (which reaches `/v1/images/generations` and, with input images, `/v1/images/edits`), bound the whole call by the shared timeout, read the output size from the image header, and record usage through `clients.recordUsage(...)` with `images` set (Muse Image bills per image: `ImagePrice { usdPerImage }` in the estimator). Large base64 payloads in fixtures are stored as separate files in `fixtures/meta/<task>/<name>.files/`.
- Structured output uses `generateText({ output: Output.object({ schema }) })` (`generateObject` is deprecated in AI SDK 7) in strict `json_schema` mode, which Meta enforces server-side: output schemas use `.nullable()`, never `.optional()`.
- Voice Transcribe (P1-04; details in [model-notes.md](./model-notes.md#p1-04--voice-transcribe)): `transcribeAudio({ openai, usage, estimateCost? }, { model, mode, audio, keywords?, languageBias?, ... })` sends the multipart body (`request` JSON part + `audio` WAV part) through `openai.post` and returns `{ sessionId, text, audioDurationMs, turns: TranscriptTurn[] }`, `TranscriptTurn = { index, speaker?, text, startMs, endMs }`. Usage is recorded as `UsageEntry.audioDurationMs` (no tokens). Audio is converted beforehand by `apps/api/src/media/convert.ts` (ffmpeg → 16 kHz mono 16-bit PCM WAV, header verified).

The Vercel AI SDK is the primary client. The official `openai` package fills the gaps where the AI SDK does not reach an endpoint or changes its output. Native `fetch` is a last resort, used only if neither SDK can express a request.

| Model                       | Used for                                                                                            | Client                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `muse-spark-1.3`            | Fact extraction, photo classification, copy and Q&A generation, default fallback for judgment steps | AI SDK (Responses API; structured output via zod)                                                                                      |
| `muse-wonder-1.0`           | Reconciliation and verification judgment (per-step configurable)                                    | AI SDK                                                                                                                                 |
| `muse-voice-transcribe-1.0` | Voice walkthrough transcription (`POST /v1/asr/transcribe`, not an OpenAI-standard endpoint)        | `openai` SDK custom request (`client.post`)                                                                                            |
| `sam-3.1`                   | Privacy masks, evidence regions, structural integrity check                                         | AI SDK (Responses API); `openai` SDK `responses.create` if the AI SDK alters the special-token output. Masks parsed by our own parser. |
| `muse-image-1.0`            | Virtual staging edits                                                                               | AI SDK `generateImage`: input images route it to `/v1/images/edits` (verified in P1-06, see model notes)                               |

Known API constraints the design depends on (from Meta's docs):

- **Voice Transcribe** file endpoint accepts only mono 16-bit PCM WAV at 16 or 24 kHz, max 32 MB and 10 minutes. Timestamps are turn-level only (`startMs`/`endMs`); there are no word-level timestamps. Keyword biasing is supported. Turn timestamps are the evidence anchors for transcript claims. Measured in P1-04: turns exist only in `ENDPOINTING`/`DIARIZATION` mode (empty in the default `PUSH_TO_TALK`), and `ENDPOINTING` returned a single turn for a 2:49 TTS clip, so turn-level anchors may be coarse; the transcript can repeat words ("12 12"), so transcript numbers are never cited directly.
- **SAM 3.1** takes one noun phrase per request; several object types mean several requests. Masks come back as special-token text that must be parsed (see the cookbook's `07_sam` recipes). SAM segments; it does not classify — classification is Spark's job.
- **Muse Image** edits do **not** accept a mask. The docs say edits keep the rest of the image intact but do not guarantee pixel preservation, and output dimensions may differ from the input. This is why the integrity check exists — and why its feasibility is verified in Phase 1 before staging is committed to.
- **Reasoning tokens are billed at output rates** ($20/1M on Wonder). Reasoning effort is therefore set per step, not globally.

To verify in Phase 1 against the pinned SDK versions: which SDK covers each endpoint (the client column above is the starting hypothesis) and whether the `openai` SDK's custom request can send the transcription multipart body. Verified in P1-02: reasoning-effort pass-through, structured-output behavior, and usage fields (reasoning tokens are reported in `output_tokens_details.reasoning_tokens` and included in `output_tokens` for text, vision, and structured calls).

## 5. Run pipeline

| #   | Step             | Model(s)                                            | Input → Output                                                                | Notes                                                                                                                                                                                                                  |
| --- | ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Intake           | Voice Transcribe                                    | Audio (converted by ffmpeg) → transcript turns with timestamps                | Keyword biasing from the fact form and market profile (street names, room terms).                                                                                                                                      |
| 2   | Fact extraction  | Spark 1.3 `low`                                     | Transcript + fact form → candidate facts                                      | Structured output validated by zod. Each fact carries provenance: form field or transcript turn.                                                                                                                       |
| 3   | Vision inventory | Spark 1.3 `low` + SAM 3.1                           | Photos → per-photo inventory                                                  | Spark: room/subject, quality, cover ranking. SAM: privacy masks (person, license plate) and a capped number of evidence regions for fact-relevant objects.                                                             |
| 4   | Reconciliation   | Wonder 1.0 `low` (fallback Spark 1.3 `medium`)      | Candidate facts + form + photo evidence → Verified Fact Sheet + conflict list | Areas compared as value + unit + basis. Conflicts pause the run at **Gate 1**.                                                                                                                                         |
| 5   | Creative         | Spark 1.3 `medium` (copy), `low` (Q&A) + Muse Image | Fact Sheet + inventory → copy variants, Q&A cards, staging variants           | Copy is emitted as claim segments, each with `fact_ids[]`. Staging requests are explicit declared operations (e.g., "add sofa", "remove clutter from table").                                                          |
| 6   | Integrity check  | SAM 3.1 + code                                      | Original vs. staged image → pass/fail                                         | Resize to common dimensions; segment fixed elements (windows, doors, radiators); compare counts and bounding-box IoU against a threshold chosen in Phase 1. Fail → one retry; second failure → keep the original only. |
| 7   | Verification     | Wonder 1.0 `low` (fallback Spark 1.3 `medium`)      | Copy + Fact Sheet + rubric + market profile → Claim Audit                     | Checks claim support, superlatives and promises, exclusionary phrasing, profile-specific rules. Max 2 revision loops back to step 5; remaining flags go to **Gate 2**.                                                 |
| 8   | Export           | Code only                                           | Approved pack → HTML pack + portal-fields JSON                                | Deterministic and reproducible from stored artifacts. Faces/plates blurred in exported images.                                                                                                                         |

**Gates:** Gate 1 (fact conflicts) after step 4; Gate 2 (claim audit and image approval) after steps 6–7.

**Model and effort defaults (P1-03).** The efforts above are the service-definition defaults (§7), chosen from measurements on a reconciliation-sized synthetic input (~4.3k input tokens, four planted defects) and one verification-sized call; details in [model-notes.md](./model-notes.md#p1-03--wonder-10-cost-and-latency).

- Wonder `low` caught every planted defect in reconciliation ($0.076, 13.7 s) and verification ($0.05, 12.5 s). `medium` (+25% cost) and `high` (+70%) added nothing and produced slightly messier output, so judgment steps start at `low`.
- Spark `medium` matched Wonder on reconciliation at 46% of the cost but 60% more latency (6× the reasoning tokens). It is the fallback for both judgment steps, and promoting it to primary is a definition change if the budget tightens.
- Spark steps (extraction, classification, Q&A) use `low`. Creative copy uses `medium` because a segment that fails the validator or verifier costs a revision loop (~$0.08). P3-01 confirms this setting with the validator pass rate.
- Every step sets `max_output_tokens` at about 4× its expected output, so one runaway reasoning call cannot consume the run budget.
- Reconciliation constraint for P2-09: every model verified a basis-less gross area (104 m²) as a fact under a different free-text key each time. `basis` must therefore be limited to the market profile's bases plus an explicit "other/unspecified" value, and keys must be normalized against the profile so that such areas can never be cited as living area.

## 6. Provenance: "no source, no claim"

1. The creative step receives only the Verified Fact Sheet and must return copy as structured segments: `{ text, fact_ids[] }`.
2. A code-level validator rejects any segment with empty or unknown `fact_ids`, and compares every number in the text to the cited fact exactly. This runs before any model-based verification.
3. The verifier judges semantic support: does the cited fact actually justify this wording?
4. In the UI, clicking a claim shows its evidence: the form field, the transcript turn (with timestamp and audio playback from that point), or the photo with its SAM mask overlay.

## 7. Definition formats

Files: `definitions/services/<id>.v<version>.yaml` and `definitions/markets/<id>.v<version>.yaml`; the file name must match the content's ID and version. Schemas: `packages/shared/src/definitions.ts` (shared because the web fact form is generated from the market profile schema). Loader: `apps/api/src/definitions/` (P2-02).

- **Parsing:** YAML 1.2 core schema with duplicate keys, unknown tags (every parser warning), merge keys, and aliases rejected. All objects are strict zod objects, so an unknown key is an error.
- **Errors** name the file, line and column, the path inside the document, and the problem, e.g. `markets/nl.v1.yaml:12:66: market.facts[1].basis: Area basis "gross" is not listed in area_bases`. One error lists every problem in every file.
- **Boot:** `server.ts` and `worker.ts` call `bootDefinitions` before opening the database pool, port, or queue; any problem is logged as fatal and the process exits with code 1. Boot also requires the published `listing-launch` v1, `international` v1, and `nl` v1 to be present. The directory defaults to the repository's `definitions/` (resolved from the source location; the API image copies it to `/app/definitions`) and can be overridden with `DEFINITIONS_DIR`.
- **Versions are immutable** once runs reference them: a change is a new file with the next version. The registry is frozen and looked up by `getService(id, version)` / `getMarket(id, version)`.

Service definition (`listing-launch.v1.yaml` without comments; steps read model, effort, and token cap from here, never from code):

```yaml
service:
  id: listing-launch
  version: 1
  name: Listing launch
  inputs:
    - key: photos
      type: images
      min: 10
      max: 30
      required: true
    - key: voice_memo
      type: audio
      max_seconds: 600
      required: true
    - key: facts
      type: form
      schema: from_market_profile
      source_of_truth: true
      required: true
  steps:
    - id: intake
      agent: intake
      model: muse-voice-transcribe-1.0
    - id: fact_extraction
      agent: extractor
      model: muse-spark-1.3
      reasoning_effort: low
      max_output_tokens: 8000
    - id: vision_inventory
      agent: vision
      model: muse-spark-1.3
      reasoning_effort: low
      max_output_tokens: 4000
      segmentation_model: sam-3.1
      max_evidence_masks: 12
    - id: reconciliation
      agent: reconciler
      model: muse-wonder-1.0
      reasoning_effort: low
      max_output_tokens: 12000
      fallback_model: muse-spark-1.3
      fallback_reasoning_effort: medium
      gate_after: fact_conflicts
    - id: creative
      agent: creative
      model: muse-spark-1.3
      reasoning_effort: medium
      max_output_tokens: 16000
      image_model: muse-image-1.0
    - id: qa_cards
      agent: qa_writer
      model: muse-spark-1.3
      reasoning_effort: low
      max_output_tokens: 8000
    - id: integrity
      agent: integrity_checker
      segmentation_model: sam-3.1
    - id: verification
      agent: verifier
      model: muse-wonder-1.0
      reasoning_effort: low
      max_output_tokens: 12000
      fallback_model: muse-spark-1.3
      fallback_reasoning_effort: medium
      max_revision_loops: 2
      gate_after: claim_audit
    - id: export
      agent: exporter
  budget:
    max_cost_usd_per_run: '0.50'
```

- Steps are a union on `agent` (`intake`, `extractor`, `vision`, `reconciler`, `creative`, `qa_writer`, `integrity_checker`, `verifier`, `exporter`); each agent allows only its own fields. Buyer Q&A is its own step, so cut level 1 removes one entry.
- Every model ID (`model`, `fallback_model`, `segmentation_model`, `image_model`) must exist in `PRICE_TABLE`, so an unpriced model fails at boot rather than at the first call. `-contributor` IDs are rejected.
- Language-model steps require `reasoning_effort` (validated by `metaReasoningEffortSchema`, the same set for Spark and Wonder) and `max_output_tokens` (bounds the worst-case reasoning cost of one call; per photo in vision inventory). Efforts are rejected on models not billed per token. `fallback_model` must differ from `model` and requires `fallback_reasoning_effort`.
- Step IDs, input keys, and gates are unique; `gate_after` is a known gate.
- `max_cost_usd_per_run` is a quoted exact decimal (`usdAmountSchema`, greater than zero). An unquoted YAML number is a float and is rejected, not coerced, so the cap reaches the ledger without a float round trip.

Market profile (`nl.v1.yaml` without comments; `international.v1.yaml` has the same shape with generic facts and bases):

```yaml
market:
  id: nl
  version: 1
  name: Netherlands
  source_languages: [nl, en]
  output_languages: [en, nl]
  default_output_language: en
  units:
    area: m2
    volume: m3
  currency: EUR
  area_bases:
    - id: NEN2580
      label: NEN 2580 usable area (gebruiksoppervlakte wonen), per the BBMI measurement instruction
    - id: cadastral
      label: Plot size as registered by the Kadaster
  facts:
    - key: energy_label
      label: Energy label (energielabel)
      type: enum
      values: [A++++, A+++, A++, A+, A, B, C, D, E, F, G]
      required: true
    - key: living_area
      label: Living area (woonoppervlakte)
      type: area
      basis: NEN2580
      required: true
    - key: volume
      label: Volume (inhoud)
      type: volume
    - key: plot_area
      label: Plot area (perceeloppervlakte)
      type: area
      basis: cadastral
    - key: build_year
      label: Build year (bouwjaar)
      type: integer
      min: 1000
      max: 2100
    - key: vve_monthly_contribution
      label: Owners' association (VvE) monthly contribution
      type: money
    - key: ground_lease
      label: Land under ground lease (erfpacht)
      type: boolean
    - key: ground_lease_annual_fee
      label: Ground lease annual fee (canon)
      type: money
  publication_checklist:
    - id: energy_label_shown
      label: The energy label class is shown in the listing
      rule: fact_present
      fact: energy_label
    - id: staging_disclosed
      label: Every virtually staged image is labeled as such
      rule: staged_images_labeled
  flagged_phrasing: [exclusionary, investment_promise, unverifiable_superlative]
```

- Fact types: `enum` (`values`), `area` (`basis`), `volume`, `integer` (`min`/`max`), `money`, `boolean`. Facts are scalar so the form and the Fact Sheet stay flat; ground lease is two facts rather than an object. `required` defaults to `false`; `label` feeds the generated form.
- Area facts carry a basis listed in `area_bases`; their unit is `units.area`. Volume facts need `units.volume`, money facts need `currency`.
- Checklist rules: `fact_present` (references a known fact), `staged_images_labeled`, `no_flagged_phrasing` (category listed in `flagged_phrasing`). Phrasing categories are a closed set because the verifier implements each.
- Languages are known ISO 639-1 codes; `default_output_language` must be in `output_languages`. Fact keys, basis IDs, checklist IDs, and enum values are unique.
- The energy label classes follow RVO and the official conversion table for homes (sources cited in the YAML). A0 (zero-emission homes from 2026) is an indicator on the label, not a class.

## 8. Data model

Drizzle schema in `apps/api/src/db/schema.ts`, migrations in `apps/api/drizzle/`, repository functions in `apps/api/src/db/repositories/` (each takes the database or an open transaction, so callers compose writes and pg-boss enqueues into one transaction).

- `users`, `sessions` — single-operator accounts. Emails are stored normalized (unique on `lower(email)`); sessions are keyed by a hash of the session token, never the raw token.
- `projects` — one listing job: owner, title, office profile snapshot (JSON, zod-validated), market profile ID + version, output language, fact form values (JSON), status (`draft | active | archived`).
- `materials` — uploaded files: kind (`photo | voice_memo`), storage key (unique), MIME type, size, SHA-256, processing status (`uploaded | processing | ready | failed`), processing metadata. Size and SHA-256 describe the **stored** (processed) bytes. Metadata is zod-validated by the shapes in `packages/shared/src/materials.ts` (strict objects, so nothing unexpected is persisted):
  - `ready` photo: `{ width, height, sourceFormat: 'jpeg' | 'png' | 'webp', sourceWidth, sourceHeight }` (source dimensions after EXIF orientation).
  - `ready` voice memo: `{ durationMs, sampleRate: 16000 | 24000, sourceContainer, sourceCodec }`; `durationMs` comes from the stored WAV's samples, not the upload's header.
  - `failed`: `{ failureReason }`, a code from `MATERIAL_FAILURE_REASONS` (upload rejection codes plus `internal_error`), never decoder output or paths.
- `runs` — one execution of a service definition version: service ID + version and market profile ID + version recorded for reproducibility; status `queued → running → awaiting_gate → completed | failed`; the open gate, current step, failure reason, start/finish times.
  - Allowed transitions: `queued → running | failed`, `running → awaiting_gate | completed | failed`, `awaiting_gate → running | failed`, `failed → queued` (resume). `completed` is terminal. `transitionRun` locks the run row, rejects other transitions with a typed error, and appends a `run_status_changed` event in the same transaction.
  - Check constraints make gates real states: `gate` is set exactly when `status = 'awaiting_gate'`, and `failed` requires a failure reason.
- `run_events` — append-only event log per run, primary key `(run_id, seq)`. `seq` is gapless and strictly increasing per run: it comes from incrementing `runs.last_event_seq`, which row-locks the run, so concurrent appends serialize and commit in order. `occurred_at` defaults to `clock_timestamp()` so events in one transaction keep distinct times for replay. A trigger rejects direct UPDATE and DELETE; deletes cascading from `runs` are allowed. Event types are an app-validated text set (`RUN_EVENT_TYPES` in `packages/shared`), so new types need no migration.
- `facts` — per run: key, value (JSON), unit, measurement basis, producing step, provenance (`source_kind`: `form | transcript_turn | photo_region`, plus `source_ref` JSON: form field; transcript artifact ID + turn index + start/end ms; or photo material ID + normalized region + optional mask artifact ID), status (`candidate | verified | conflicted | rejected`).
- `artifacts` — generated outputs per run and step: kind (open snake_case set), JSON content and/or a stored file (storage key + MIME type), and the `usage_ledger` IDs of the model calls that produced them.
- `claims` — one row per copy segment: artifact, segment index, text, fact IDs exactly as cited (text array, no FK, so the validator can record and reject unknown IDs), validator result (`pass | fail`) + details, verifier verdict (`supported | unsupported | flagged`) + details.
- `decisions` — human gate decisions: gate (`fact_conflicts | claim_audit`), target (`fact | claim | artifact` + ID), choice (`accept | edit | remove | reject`), edited value (required exactly for `edit`), decided by, decided at. One decision per target per gate. `recordDecision` refuses unless the run is currently awaiting that gate and the target belongs to the run.
- `usage_ledger` — one row per model call: model ID, step, input/output/reasoning tokens, audio seconds (`numeric(10,3)`), images, estimated cost in USD (`numeric(12,8)`, exact decimal strings end to end — never floats), latency, run (nullable for calls outside a run).

**State columns** use Postgres enums generated from `as const` tuples in `packages/shared` (one source for the DB, API, and web; erasable-TS compatible). Open taxonomies that the pipeline extends (run event types, artifact kinds) are text validated in code.

**Deletion:** every project-derived row cascades from `projects` (and `projects` from `users`), so deleting a project hard-deletes its materials, runs, events, facts, artifacts, claims, and decisions in one statement; `deleteProject` returns the storage keys so the caller removes the files. `usage_ledger` is the exception: its `run_id` is set to NULL. Ledger rows contain no customer content (model ID, unit counts, cost, latency), and keeping them stops a deleted project from erasing spend from the global daily cap.

**Uploads and storage (P2-05).** Code: `apps/api/src/storage/` (`Storage` interface, `createLocalStorage`), `apps/api/src/media/` (`image.ts`, `audio.ts`, `probe.ts`, plus the P1-04 `convert.ts`), `apps/api/src/uploads/process-upload.ts`. No HTTP endpoint yet; P4-03 adds the route (ownership check, multipart into a temp file) and calls `processUpload`.

- **Storage:** `put(key, bytes | stream) → { key, sizeBytes, sha256 }`, `get(key) → stream` (`StorageNotFoundError`), idempotent `delete`, `exists`. Keys are opaque and server-generated (`projects/<projectId>/materials/<uuid>.<ext>`), restricted to lower-case `/`-separated segments that cannot start with `.`, and checked again against the root after path resolution, so traversal is impossible. Writes go to `<root>/.tmp/<uuid>` (mode 0600), are fsynced, renamed into place, and the directory is fsynced: an object is either absent or complete. The local implementation is rooted at `STORAGE_DIR` (absolute; required in production, where it is the `/data` volume; `<repo>/data/storage` otherwise). `delete` removes the file permanently, which P5-04 uses with the keys `deleteProject` returns; empty directories are left in place (their names are UUIDs).
- **`processUpload({ projectId, kind, tempFilePath, clientMime? })`:** validate and process → `storage.put` → `addMaterial` (`processing`, stored size and SHA-256) → `ready` with metadata. It owns the temp file and deletes it, and every intermediate file, on every path. Invalid uploads throw `UploadRejectedError` with a code (`UPLOAD_REJECTION_CODES` in `packages/shared`) and an uploader-safe message; nothing is stored and no row is written, because a row needs a stored file. A failure after storing deletes the file; if the row already exists, it becomes `failed` with `{ failureReason }`. `clientMime` is never used for validation.
- **Photos (sharp):** limits in `UPLOAD_LIMITS` (25 MiB, 100 MP, long edge 2048 px). The container is identified by magic bytes before any decoder runs (JPEG, PNG, WebP), so libvips never parses SVG, PDF, TIFF, or GIF; sharp's header metadata must agree. The pixel count is checked on the header and enforced again by `limitInputPixels` during decoding (decompression bombs); `failOn: 'error'` rejects corrupt and truncated files. Then: auto-orient by EXIF, downscale to fit the long edge (never enlarge), flatten transparency onto white, convert to sRGB through the embedded ICC profile, and encode JPEG (quality 85, mozjpeg). sharp writes no metadata unless asked, so the output has no EXIF (incl. GPS), XMP, IPTC, comments, or ICC profile; a test builds a JPEG with GPS EXIF, XMP, orientation, and a P3 profile and checks both sharp's reader and the raw JPEG segments. **JPEG over WebP:** listing portals and every export target accept JPEG, the vision models take it, and the size difference at 2048 px is small.
- **HEIC is rejected** (`heic_not_supported`): sharp's prebuilt libvips includes libheif with the AV1 decoder only (HEVC is patent-encumbered), so it reads AVIF but not iPhone HEIC (verified in sharp 0.35.5: `sharp.format.heif` lists only `.avif`). The web app converts photos on the device during client-side downscaling (P4-03); iPhones set to "Most Compatible" upload JPEG anyway. AVIF is refused too, as it is not an accepted format.
- **Voice memos (ffmpeg):** limits 128 MiB (10 minutes of 48 kHz stereo WAV) and 600 s. `ffprobe` (argument array, `shell: false`, 15 s timeout, `-protocol_whitelist file`, `-format_whitelist` of the accepted demuxers) validates the container (MP4/M4A, WebM/Matroska, Ogg, WAV, MP3, FLAC, ADTS AAC, AMR), exactly one audio stream with an allow-listed codec, and no real video stream (cover art is allowed). A declared duration over the limit is rejected before decoding. Browser-recorded WebM declares no duration and headers can be forged, so the shared converter now takes `maxDurationMs` (ffmpeg `-t`), set to limit + 1 s: decoding work and WAV size stay bounded, and the measured WAV duration decides `too_long`. The converter also passes `-protocol_whitelist file`. The 16 kHz mono 16-bit transcription WAV is what is stored.
- **Originals are not kept** (data minimization): they carry GPS and device metadata, and nothing downstream needs them. The trade-off is that changing processing settings later requires a re-upload.

## 9. Runs, jobs, and reliability

- Each pipeline step is a pg-boss job with an idempotency key (`run_id + step_id + attempt scope`). A completed step is never re-executed or re-billed on retry or restart.
- Run state changes and job enqueues happen in the same database transaction (pg-boss can send through a caller-provided executor — confirm against the pinned version).
- Step timeouts; a step that fails twice marks the run failed in a resumable state.
- If Wonder is unavailable, judgment steps fall back to Spark and the result is labeled as such.

## 10. Cost controls

| Item             | List price (Standard mode)                                       | Per-run expectation                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spark 1.3        | $1.25 in / $4.25 out per 1M tokens                               | ~$0.09–0.12 typical (extraction ~$0.02 at `low`, classification ~$0.003/photo at `low`, copy ~$0.03 at `medium`, Q&A ~$0.01 at `low`; extraction, copy, and Q&A extrapolated). Measured: a reconciliation-sized prompt (4.8k in) cost $0.035 at `medium` (5.5k reasoning, 22 s) and $0.048 at `high` (8.4k reasoning, 31 s); a 640×480 image is ~380 input tokens; at the default effort `high`, ~95% of a short answer is reasoning (P1-01/P1-02/P1-03) |
| Wonder 1.0       | $4.00 in / $20.00 out per 1M tokens (reasoning billed as output) | ~$0.13 typical, ≤ $0.23 with two verification revision loops. Measured (P1-03): reconciliation (4.3k in) $0.076 at `low` (0.9k reasoning, 14 s), $0.095–0.098 at `medium` (~2k, 20–23 s), $0.129 at `high` (3.7k, 23 s); verification (2k in, 26 segments) $0.050 at `low` (1.3k reasoning, 13 s). The ~2k-token answer, not reasoning, dominates cost at `low`                                                                                          |
| Voice Transcribe | $0.18 per audio hour                                             | Measured (P1-04): a 2:49 walkthrough billed 168.8 s of audio = $0.0084 (≈ $0.003 per audio minute); ~$0.01–0.03 per run                                                                                                                                                                                                                                                                                                                                  |
| Muse Image       | $0.01 per image                                                  | ~$0.03–0.06 (3–6 staged images; each integrity-check retry adds $0.01). Measured (P1-06): flat per returned image per Meta's pricing page; the `usage` tokens it reports (10–21k in, 0.5–2k out) are informational. Latency: edits 8–16 s, generations 9–29 s                                                                                                                                                                                            |
| SAM 3.1          | $2.50 per 1,000 images                                           | ~$0.05–0.15 (one request per image per noun phrase)                                                                                                                                                                                                                                                                                                                                                                                                      |

Language-model steps at the P1-03 defaults (§5): **~$0.22–0.25 per typical run** (10–20 photos, one verification pass) and ~$0.44 in the worst case (30 photos, two full revision loops). With voice, image, and SAM costs a typical run is ~$0.31–0.49. A worst-case run can exceed the $0.50 cap and then stops there, so revision loops (P3-06) should regenerate and re-verify only the revised segments. Meta reports `cached_tokens` for a repeated prompt prefix (4.2k of 4.3k on an identical request); the price table has no cached-input rate yet, so estimates bill them at the full input price.

Controls: per-run budget cap (fails the run loudly), global daily budget cap, per-IP and per-account rate limits, an access code for live runs on the public deployment, and a zero-cost demo replay mode. Web search grounding ($2.50 per 1,000 queries) is off by default.

**Usage ledger and budget caps (P2-04).** Code: `packages/shared/src/prices.ts` (price table, `computeCostUsd`), `packages/shared/src/decimal.ts`, `apps/api/src/usage/` (`ledger.ts`, `budget.ts`).

- **Price table:** `PRICE_TABLE` in `packages/shared`, zod-validated, keyed by model ID. Each model has one billing kind — `tokens` (`inputUsdPerToken`, `outputUsdPerToken`), `audio_seconds` (`usdPerAudioSecond`), or `images` (`usdPerImage`) — with prices as decimal strings **per single unit**, so cost = units × price is always an exact product (a per-hour price divided by 3600 is not a terminating decimal in general). A unit test pins the table to the list prices above. Cached input tokens bill at the full input rate (no discount is documented); reasoning tokens are inside `output_tokens` and are never added again.
- **Cost math:** scaled-BigInt decimals, never floats. Costs are rounded **up** to 8 fraction digits (`numeric(12,8)`), so the ledger may over-report a call by at most $0.00000001 but never under-reports spend against a cap. The meta module's `CostEstimator` keeps returning a number for display and logs (`createPriceTableCostEstimator` derives it from the same computation); the persisted cost is computed by the ledger from the units.
- **Ledger:** `createUsageLedger({ db, runId, stepId, dailyCapUsd, runCapUsd? })` implements `UsageRecorder`. It is created per step execution, together with that step's Meta clients, so entries carry the right run and step. `flush()` takes the buffer synchronously and writes it in one transaction; on a database error the entries stay buffered and `UsagePersistenceError` is thrown. `meter(modelId, call)` is how steps call models: price check → budget check → call → `flush()`, flushing also when the call throws (a call that fails on output parsing has still been billed).
- **Fail loud, not record-with-flag:** a model without a price is refused before the call (`UnpricedModelError`), so no unmetered money is spent. A completed call with missing or invalid units (e.g. the API did not report token counts) makes `flush()` persist every priceable entry and then throw `UnpricedUsageError`. Recording such a call as $0 would silently remove it from the caps, and a flag column would only move the problem to whoever reads it. A reported `0` is a real count.
- **Caps:** checked before every call; `spent >= limit` throws `BudgetExceededError { kind: 'run' | 'daily', limitUsd, spentUsd }`, which is not retryable. The run cap comes from the service definition (`budget.max_cost_usd_per_run`) through the caller. The daily cap is `DAILY_BUDGET_USD` (exact decimal; required in production, `5.00` in development/test; `0` stops all calls) and covers every ledger row in the current **UTC** day `[00:00Z, next 00:00Z)`, including calls outside runs and rows whose run was deleted. UTC rather than Europe/Amsterdam: every day is 24 hours and the boundary is independent of the server time zone.
- **Concurrency: bounded overshoot, not serialized.** The check reads committed ledger rows and reserves nothing, because a call's cost is known only after it returns; an advisory lock would serialize the check without preventing the overshoot. A cap can therefore be exceeded by the cost of the calls already in flight when it is crossed: one call for a sequential step, the step's fan-out for parallel calls (e.g. vision inventory), and across concurrent runs for the daily cap. With measured per-call costs of a few cents (more for Wonder at high effort) the overshoot stays small; the next check stops the work.

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

- Uploads validated by content (magic bytes and decoder headers for photos, ffprobe for audio; never the extension or client MIME type), size, pixel count, and duration; images re-encoded with all metadata (including GPS) removed; only the processed files are stored, never the originals (§8, P2-05).
- Faces and license plates blurred in exported images by default.
- Project deletion hard-deletes materials, artifacts, and derived data. Usage ledger rows (no customer content) are kept with their run reference cleared, so cost caps stay accurate (§8).
- No customer content is sent to Contributor-mode models or used for training/fine-tuning.
- EU hosting; data minimization by default (GDPR).

## 15. References

Meta model cookbook (`github.com/meta-models/meta-model-cookbook`): `01_api_fundamentals` (structured output, vision, error handling), `02_agent_patterns` (validated in-place edits), `04_muse_code` (staged approvals, append-only audit log, deterministic replay in CI), `05_muse_image`, `06_muse_voice`, `07_sam`.
