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
| API              | Express 5, zod validation, Server-Sent Events for run progress, pino logging, in-process fixed-window rate limiter (single instance, no new dependency), yaml (strict YAML 1.2 parsing of definition files)                                                                                                                |
| Worker           | Separate Node process from the same codebase, consuming pg-boss jobs                                                                                                                                                                                                                                                       |
| Database         | PostgreSQL, Drizzle ORM + drizzle-kit migrations, `pg` driver                                                                                                                                                                                                                                                              |
| Queue            | pg-boss (Postgres-backed); no Redis                                                                                                                                                                                                                                                                                        |
| AI               | Vercel AI SDK (`ai` + `@ai-sdk/openai`, base URL `https://api.meta.ai/v1`) as the primary client; the official `openai` npm package for capabilities the AI SDK does not cover (see §4); `@meta-sam/parser` (Meta's official SAM output parser, SAM License) only to decode SAM mask payloads                              |
| Media            | sharp (resize, metadata strip, re-encode, blur, image alignment), ffmpeg (audio → WAV)                                                                                                                                                                                                                                     |
| Storage          | Local filesystem on a Docker volume, behind a storage interface                                                                                                                                                                                                                                                            |
| Auth             | Email + password (argon2id via `@node-rs/argon2`), httpOnly cookie sessions stored in Postgres (hashed tokens); details in §14                                                                                                                                                                                             |
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

Consequences of native type stripping for `apps/api` and `packages/shared`: only erasable TypeScript syntax (no `enum`, no parameter properties, no namespaces with runtime code), relative imports carry the `.ts` extension, type-only imports use `import type`, and tsconfig `paths` aliases are not available. The web app uses bundler resolution and is unaffected. The web app consumes `@evidomo/shared` as source without a build step: `transpilePackages: ['@evidomo/shared']` in `apps/web/next.config.ts` makes Next compile it and bundle it into the routes (so the web runtime image needs no shared sources), and `allowImportingTsExtensions` in `apps/web/tsconfig.json` lets the web type check follow its `.ts` imports. The web app's own imports stay extensionless.

Pages Router treats every file under `apps/web/src/pages` as a route, so web tests live in `apps/web/src/__tests__`.

Caddy routes `/api/*` to the API and everything else to the web app on the same domain, so cookies stay same-site and no CORS configuration is needed. In development the Next.js dev server plays that role: a rewrite active only under `next dev` proxies `/api/:path*` to `API_PROXY_ORIGIN` (default `http://localhost:4000`), so the browser stays on `http://localhost:3000`, the API's default `APP_ORIGIN`. Production builds carry no rewrite (`next start` answers 404 on `/api`; Caddy never sends it there).

## 4. Meta Model API integration

All model access goes through one `meta` module in `apps/api/src/meta`: client configuration, timeouts, usage capture into the ledger, and the record/replay switch used by tests. Retries (exponential backoff on 429/5xx, honoring `Retry-After`) use the SDKs' built-in retry settings; the module does not add a second retry layer on top. Both SDKs call the API over `fetch`, so MSW record/replay works the same for either.

Module interface (P1-01; details and measured shapes in [model-notes.md](./model-notes.md#p1-01--meta-client-module)):

- `createMetaClients({ apiKey, usage, estimateCost?, logger?, maxRetries?, timeoutMs? })` returns the AI SDK provider (`createOpenAI({ name: 'meta' })`, Responses models via `languageModel(id)`), the `openai` client, `aiSdkCallOptions()`, and `captureOpenAIUsage(call)`. The AI SDK has no provider-level retry/timeout settings, so every AI SDK call spreads `...aiSdkCallOptions()` (`maxRetries`, `timeout`, and the `onLanguageModelCallEnd` usage hook). The `openai` timeout is per attempt; the AI SDK timeout covers the whole call including retries.
- A shared fetch wrapper rejects any request whose `model` ends in `-contributor` (principle 6, enforced in code for both SDKs).
- Usage capture: `UsageRecorder.record(entry)` receives model ID, input/cached/output/reasoning tokens, latency, response ID, `estimatedCostUsd` from a pluggable `CostEstimator`, and, for non-token models, `audioDurationMs` (whole milliseconds, Voice) or `images` (Muse Image, SAM). `record` is synchronous because the AI SDK silently swallows errors thrown by its callbacks; the usage ledger (P2-04, §10) buffers and persists after the call returns. `estimatedCostUsd` is a float for display and logs only; the ledger persists an exact decimal computed from the units.
- Record/replay (`replay.ts`, test-only): fixtures in `fixtures/meta/<task>/<name>.json`, matched by method, path, and a hash of the normalized body; replay never touches the network and fails loudly on an unmatched request; `RECORD=1` records 2xx responses only and never stores request headers.
- `MODEL_API_KEY` is required at boot in production and optional in development/test (replay tests use a placeholder).
- Per-call model settings (P1-02; [model-notes.md](./model-notes.md#p1-02--spark-13-text-vision-structured-output)): AI SDK calls pass `providerOptions: metaProviderOptions({ reasoningEffort, store? })`, `openai` SDK calls spread `metaResponsesParams(...)`. The helper exists because `@ai-sdk/openai` reads only the `openai` options key (options under `meta` are dropped silently) and drops `reasoningEffort` for non-OpenAI model IDs unless `forceReasoning: true`. Accepted efforts for Spark and Wonder (P1-03) are `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (`none` is rejected); `metaReasoningEffortSchema` validates definition values. `store` defaults to `false` because steps carry customer content.
- Images (P1-06; [model-notes.md](./model-notes.md#p1-06--muse-image-edits)): `generateMetaImage(clients, { modelId, prompt, size?, outputFormat? })` and `editMetaImage(clients, { ..., images })` in `meta/images.ts` call the AI SDK `generateImage` on `clients.imageModel(id)` (which reaches `/v1/images/generations` and, with input images, `/v1/images/edits`), bound the whole call by the shared timeout, read the output size from the image header, and record usage through `clients.recordUsage(...)` with `images` set (Muse Image bills per image: `ImagePrice { usdPerImage }` in the estimator). Large base64 payloads in fixtures are stored as separate files in `fixtures/meta/<task>/<name>.files/`. Muse Image enables image search, web search, and shell unless `tool_enablement` turns them off; only the JSON edit body validates that field, so staging of customer photos (P3-04) uses `openai.post` with all three tools off ([P1-08](./model-notes.md#p1-08--muse-image-with-tools-disabled)).
- SAM 3.1 (P1-05; [model-notes.md](./model-notes.md#p1-05--sam-31-and-output-parser)): `segmentImage(clients, { modelId, phrase, image, reasoningEffort, includeConfidence? })` in `meta/sam.ts` sends one noun phrase (validated: no lists or token characters) and one image through `generateText`, with `metaProviderOptions` plus `metadata: { mask_encoding: "one_bit", include_confidence: "true" }`. It records usage before parsing with `images` from the response's `usage.images_processed` (tokens are reported as 0), and returns `segments: { label, objectId, score?, box: { x0, y0, x1, y1 }, mask }[]`: boxes in source-image pixels, half-open; masks box-local `one_bit` rasters decoded by `decodeSamMask` (`meta/sam-mask.ts`), a wrapper over `@meta-sam/parser`'s `decodeMaskToRaster`. `parseSamImageOutput` (`meta/sam-output.ts`) rejects any deviation from the documented grammar with `SamOutputError`.
- Structured output uses `generateText({ output: Output.object({ schema }) })` (`generateObject` is deprecated in AI SDK 7) in strict `json_schema` mode, which Meta enforces server-side: output schemas use `.nullable()`, never `.optional()`.
- Voice Transcribe (P1-04; details in [model-notes.md](./model-notes.md#p1-04--voice-transcribe)): `transcribeAudio({ openai, usage, estimateCost? }, { model, mode, audio, keywords?, languageBias?, ... })` sends the multipart body (`request` JSON part + `audio` WAV part) through `openai.post` and returns `{ sessionId, text, audioDurationMs, turns: TranscriptTurn[] }`, `TranscriptTurn = { index, speaker?, text, startMs, endMs }`. Usage is recorded as `UsageEntry.audioDurationMs` (no tokens). Audio is converted beforehand by `apps/api/src/media/convert.ts` (ffmpeg → 16 kHz mono 16-bit PCM WAV, header verified).

The Vercel AI SDK is the primary client. The official `openai` package fills the gaps where the AI SDK does not reach an endpoint or changes its output. Native `fetch` is a last resort, used only if neither SDK can express a request.

| Model                       | Used for                                                                                            | Client                                                                                                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `muse-spark-1.3`            | Fact extraction, photo classification, copy and Q&A generation, default fallback for judgment steps | AI SDK (Responses API; structured output via zod)                                                                                                                                                                                                                                    |
| `muse-wonder-1.0`           | Reconciliation and verification judgment (per-step configurable)                                    | AI SDK                                                                                                                                                                                                                                                                               |
| `muse-voice-transcribe-1.0` | Voice walkthrough transcription (`POST /v1/asr/transcribe`, not an OpenAI-standard endpoint)        | `openai` SDK custom request (`client.post`)                                                                                                                                                                                                                                          |
| `sam-3.1`                   | Privacy masks, evidence regions, structural integrity check                                         | AI SDK (Responses API, non-streaming): returns the special-token text unchanged (verified in P1-05). Token grammar parsed by our own parser; mask payloads decoded by `@meta-sam/parser`.                                                                                            |
| `muse-image-1.0`            | Virtual staging edits                                                                               | `openai` SDK `client.post('/images/edits')` with Meta's JSON body (`images[].image_url`) and `tool_enablement` all `false` for customer photos (decided in P1-08, implemented in P3-04); the AI SDK `generateImage` cannot disable the built-in tools and stays for synthetic inputs |

Known API constraints the design depends on (from Meta's docs):

- **Voice Transcribe** file endpoint accepts only mono 16-bit PCM WAV at 16 or 24 kHz, max 32 MB and 10 minutes. Timestamps are turn-level only (`startMs`/`endMs`); there are no word-level timestamps. Keyword biasing is supported (no documented limit on count or length). Turn timestamps are the evidence anchors for transcript claims. Measured in P1-04/P2-06: turns exist only in `ENDPOINTING`/`DIARIZATION` mode (empty in the default `PUSH_TO_TALK`); on the same 2:49 TTS clip `ENDPOINTING` returned a single turn and `DIARIZATION` 15 turns of 2–16 s, so intake uses `DIARIZATION`; the transcript can repeat words ("12 12"), so transcript numbers are never cited directly.
- **SAM 3.1** takes one noun phrase per request; several object types mean several requests. Masks come back as special-token text that must be parsed (see the cookbook's `07_sam` recipes). SAM segments; it does not classify — classification is Spark's job.
- **Muse Image** edits do **not** accept a mask. The docs say edits keep the rest of the image intact but do not guarantee pixel preservation, and output dimensions may differ from the input. This is why the integrity check exists — and why its feasibility is verified in Phase 1 before staging is committed to.
- **Reasoning tokens are billed at output rates** ($20/1M on Wonder). Reasoning effort is therefore set per step, not globally.

Verified in Phase 1 against the pinned SDK versions (consolidated in [model-notes.md, Summary](./model-notes.md#summary)): the client column above, the transcription multipart body through `openai.post` (P1-04), reasoning-effort pass-through, structured-output behavior, and usage fields (P1-02: reasoning tokens are reported in `output_tokens_details.reasoning_tokens` and included in `output_tokens`).

## 5. Run pipeline

| #   | Step             | Model(s)                                            | Input → Output                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Intake           | Voice Transcribe `DIARIZATION`                      | Audio (converted by ffmpeg) → transcript turns with timestamps                | Keyword biasing from the fact form and market profile (street names, room terms). Turns over `max_turn_seconds` are split with approximate timestamps. Details below.                                                                                                                                                                                                                                              |
| 2   | Fact extraction  | Spark 1.3 `low`                                     | Transcript + fact form → candidate facts                                      | Structured output validated by zod, then keys, units, bases, and quotes re-checked in code. Each fact carries provenance: form field or transcript turn (with a verbatim quote). Details below.                                                                                                                                                                                                                    |
| 3   | Vision inventory | Spark 1.3 `low` + SAM 3.1                           | Photos → per-photo inventory                                                  | Spark: room/subject, quality, cover ranking. SAM: privacy masks (person, license plate) and a capped number of evidence regions for fact-relevant objects.                                                                                                                                                                                                                                                         |
| 4   | Reconciliation   | Wonder 1.0 `low` (fallback Spark 1.3 `medium`)      | Candidate facts + form + photo evidence → Verified Fact Sheet + conflict list | Areas compared as value + unit + basis. Conflicts pause the run at **Gate 1**.                                                                                                                                                                                                                                                                                                                                     |
| 5   | Creative         | Spark 1.3 `medium` (copy), `low` (Q&A) + Muse Image | Fact Sheet + inventory → copy variants, Q&A cards, staging variants           | Copy is emitted as claim segments, each with `fact_ids[]`. Staging requests are explicit declared operations (e.g., "add sofa", "remove clutter from table").                                                                                                                                                                                                                                                      |
| 6   | Integrity check  | SAM 3.1 + code                                      | Original vs. staged image → pass/fail                                         | Resize to common dimensions (unit square; aspect change > 3% fails); segment fixed elements (windows, doors, radiators); per class, counts must be equal and every instance matched one-to-one (box IoU ≥ 0.75, or for doors and radiators, which furniture may partly hide, containment ≥ 0.85 with area ratio ≥ 0.4). Chosen in P1-07; details below. Fail → one retry; second failure → keep the original only. |
| 7   | Verification     | Wonder 1.0 `low` (fallback Spark 1.3 `medium`)      | Copy + Fact Sheet + rubric + market profile → Claim Audit                     | Checks claim support, superlatives and promises, exclusionary phrasing, profile-specific rules. Max 2 revision loops back to step 5; remaining flags go to **Gate 2**.                                                                                                                                                                                                                                             |
| 8   | Export           | Code only                                           | Approved pack → HTML pack + portal-fields JSON                                | Deterministic and reproducible from stored artifacts. Faces/plates blurred in exported images.                                                                                                                                                                                                                                                                                                                     |

**Gates:** Gate 1 (fact conflicts) after step 4; Gate 2 (claim audit and image approval) after steps 6–7.

**Intake (P2-06).** Code: `apps/api/src/pipeline/intake/` (`handler.ts`, `keywords.ts`, `turns.ts`), registered in `worker.ts`; measurements in [model-notes.md](./model-notes.md#p2-06--intake-step).

- **Input:** the project's single `ready` voice memo created before the run (none, several, a missing file, a checksum mismatch, invalid metadata, or a memo longer than the service's `max_seconds` fail the run with `NonRetryableStepError` before any model call). The stored WAV is read through `Storage` and sent as `voice-memo.wav` (a fixed name: no IDs leave the process). Model, `transcription_mode`, and `max_turn_seconds` come from the step configuration; the per-attempt HTTP timeout grows with the memo length (`max(180 s, 60 s + duration / 2)`). The call goes through `ctx.ledger.meter`.
- **Keywords** (`buildTranscriptionKeywords`, deterministic): (1) free-text fact-form values whose key is not a typed market fact (street and place names; typed facts are numbers, booleans, and enums), keys in code-point order; (2) the parenthesised local terms of the profile's fact labels (`Living area (woonoppervlakte)` → `woonoppervlakte`; lists are split); (3) the profile's `transcription_keywords`. Each term is NFC-normalized with whitespace collapsed, kept only with at least two letters (skips `A`, `A++`, house numbers) and at most 64 characters (longer text is skipped, not cut), de-duplicated case-insensitively (first spelling wins), and the list is capped at 50 in that priority order. Meta documents no limit; these bounds are ours (`TRANSCRIPTION_KEYWORD_LIMITS`). `languageBias` is the profile's source languages as English names (`nl, en` → `Dutch, English`). Keywords are never logged.
- **Turns** (`toStoredTurns`): trimmed, empty turns dropped, ordered by start time (diarized turns may overlap), indices `0..n-1`. A turn longer than `max_turn_seconds` (30 s in `listing-launch.v1`) is split at sentence ends (word ends if there are too few sentences) into `ceil(duration / max)` chunks whose start times are interpolated from their character offset, marked `timing: 'approximate'`; untouched turns are `timing: 'model'`. `sourceTurnIndex` keeps the API turn.
- **Output:** one `transcript` artifact (content: `transcriptArtifactContentSchema` in `packages/shared/src/transcription.ts` — material ID and SHA-256, model, mode, session ID, billed duration, the keywords and language bias sent, `maxTurnMs`, turns `{ index, sourceTurnIndex, speaker | null, text, startMs, endMs, timing }`) and a `transcript_stored` event with counts only (turns, approximate turns, speakers, keywords, duration). Both are written in `commit(tx)`. A turn's stable ID is `(artifact ID, index)`, which is what `facts.source_ref` cites (P2-07) and where playback starts (P4-06).
- **Why an artifact, not a turns table:** §8 already models transcript provenance as artifact ID + turn index; a transcript is written once and never edited per turn; consumers read it whole (P2-07 sends the full transcript to Spark, the evidence inspector loads one transcript of tens of turns); it cascades with the run and project like every other output and is replayed with the artifacts (§11). A table would add a repository and a join for no query we need.

**Fact extraction (P2-07).** Code: `apps/api/src/pipeline/extraction/` (`handler.ts`, `form.ts`, `normalize.ts`, `prompt.ts`, `schema.ts`), registered in `worker.ts`; measurements in [model-notes.md](./model-notes.md#p2-07--fact-extraction).

- **Form (no model call):** `factFormToCandidates` maps every market fact present in `projects.fact_form` to a candidate with the profile's unit (`units.area`, `units.volume`, `currency`) and basis (area facts only), `source_kind = form`, `source_ref = { field }`. `null`/absent means unknown. A missing required fact or a value that does not fit its type (enum value, non-negative number, integer in range, boolean) fails the run with `NonRetryableStepError` naming the keys only. Other form fields (street and place names until base property fields exist) become `other:<field>` facts when the key is a slug and the value a number, boolean, or short text; anything else is skipped and counted.
- **Transcript (one Spark call):** the run's single `transcript` artifact (none or several fail the run) goes to Spark with the market vocabulary, never the fact form (a form value must not pull a spoken "95" toward "92"). Strict `json_schema` output per market: `{ facts: [{ turnIndex, quote, key, otherKey, value, unit, basis, assertion }] }` with `key` an enum of the profile's fact keys plus `other`, `unit` an enum of the profile's units, `basis` an enum of `area_bases` plus `unspecified`, `assertion` `stated | opinion`. Model, effort, and `max_output_tokens` come from the step; the call goes through `ctx.ledger.meter` with `metaProviderOptions` (`store: false`).
- **Validation in code (`normalizeExtractedFacts`), never trusting the model:** the turn must exist; the quote must occur in that turn up to whitespace and case only, and the stored quote is the exact span of the turn's text (so `turn.text.includes(quote)` holds); `other` + `otherKey` becomes `other:<slug>`, and any key not chosen from the enum is filed under `other:` too, never promoted to a profile key; profile facts take the profile's unit (a different unit from the model drops the fact) and a type-valid value (only unambiguous repairs: enum case, a plain digit string, `yes`/`no`); areas take a listed basis or `unspecified` (a missing or unknown basis becomes `unspecified`), every other fact basis `null`; anything but an explicit `stated` is stored as `opinion`; exact repeats in one turn are dropped, the same quantity in two turns is kept twice. Dropped facts and their reasons (`unknown_turn`, `quote_mismatch`, `invalid_key`, `invalid_value`, `unit_mismatch`, `duplicate`) go into the report artifact.
- **Output:** a `fact_extraction` singleton artifact (`factExtractionReportSchema`: prompt version, transcript artifact ID, model settings, counts, rejected items with clipped model text) plus the candidate `facts` rows, and a `facts_extracted` event with counts only. A truncated answer (`max_output_tokens` reached) fails the run instead of retrying at the same cap.
- **Idempotency:** the report is a singleton per run and step (`artifacts_singleton_kind_key`), and the facts are inserted only when the report row is created, in the same `commit(tx)`. A repeated commit therefore keeps the first candidate set whole. A per-row `ON CONFLICT` would instead merge two different (non-deterministic) model answers into one set.
- **Reconciliation input:** candidates use the catalog's field names (`key`, `value`, `unit`, `basis`, `quote`, `startMs`, `endMs`, plus `assertion`), so P2-09 only assigns catalog IDs (`F.<field>`, `Tnn`, `Cnn`). The catalog schema was widened for this: input values may be booleans, `speaker` is any label or `null` (diarization yields `A`, not roles), and candidates may carry `assertion`; the P1-03 fixtures are unaffected.

**Integrity check (P1-07: GO, scoped).** Code: `apps/api/src/pipeline/integrity/compare.ts`; evidence, margins, and blind spots in [model-notes.md](./model-notes.md#p1-07--integrity-check-feasibility).

- `compareFixedElements(original, edit, { thresholds?, elements? }) → IntegrityVerdict` is pure (no I/O, no model calls). Each image is `{ width, height, segments: Record<label, { box }[]> }`, so `segmentImage` results fit directly. The verdict has `passed`, `aspectRatioChange`, image-level `failures` (`aspect_ratio_changed`), `failedClasses`, and per class: counts, `countDelta`, matches (IoU, containment, area ratio, accepting rule), `worstMatchedIoU`, unmatched instances with their best IoU, and `failures` (`count_changed`, `unmatched_original`, `unmatched_edit`). Invalid input throws `IntegrityInputError`.
- Defaults (`DEFAULT_INTEGRITY_THRESHOLDS`, `DEFAULT_FIXED_ELEMENTS`): `minIoU` 0.75, `minContainment` 0.85, `minAreaRatio` 0.4, `maxAspectRatioChange` 0.03; `window` not occlusion-tolerant, `door` and `radiator` tolerant. On the six synthetic pairs, 5/5 harmless edits pass with at least 0.12 slack and the window-removal edit fails on its count. P3-05 moves these into the `integrity_checker` step of the service definition.
- It catches removed, added, and moved fixed elements; it does not see elements resized or restyled in place within tolerance, walls, floors, or anything outside the segmented classes. Gate 2 (original next to staged image) remains the backstop.
- The original is segmented once per photo and reused for every variant and retry, so each checked edit costs 3 SAM calls.

**Vision inventory (P2-08).** Code: `apps/api/src/pipeline/vision/` (`handler.ts`, `inventory.ts`, `normalize.ts`, `selection.ts`, `regions.ts`, `downscale.ts`, `errors.ts`, `prompt.ts`, `schema.ts`), registered in `worker.ts`; contracts in `packages/shared/src/vision.ts`; measurements in [model-notes.md](./model-notes.md#p2-08--vision-inventory).

- **Input:** the project's `ready` photos uploaded before the run was created, in upload order. None, more than the service's `images.max`, a missing file, a checksum or header-size mismatch, or invalid metadata fail the run with `NonRetryableStepError` before any model call. The service minimum is enforced when a run is started (P4), not here.
- **Phase 1, per photo (all photos, at most 4 model calls in flight):** one Spark call (strict `json_schema`, model/effort/`max_output_tokens` from the step) on a copy downscaled to `classification_long_edge_px` (1024 in v1; smaller photos go byte for byte), returning subject (closed set `PHOTO_SUBJECTS`), a one-sentence summary, quality (`good | acceptable | poor`) plus issues, a cover score 1–10, observations (`object` from the market's `evidence_objects` or `other` + slug, count, detail), and which privacy phrases are visible. In parallel, one SAM call per `privacy_phrases` entry (`person`, `license plate`) on the **stored** photo, always, uncapped.
- **Validation in code (`normalizeClassification`):** subject and quality must be in their sets (else the photo's classification fails); cover score and counts are rounded and clamped (recorded in `repairs`); `other` names must be `snake_case` slugs (a slug naming a configured object becomes that object); zero counts, duplicates per photo, and observations beyond 15 are rejected and listed in the artifact.
- **Phase 2, evidence (`max_evidence_masks` per run):** only (photo, object) pairs that Spark observed and that have a SAM phrase are candidates, so no call is spent on objects Spark did not see. `selectEvidenceRequests` picks at most the cap, breadth first: one request per distinct object in market priority order (better-quality photos first) before a second photo of any object. Evidence masks are capped too: every answered request keeps its best-scoring mask, then the remaining budget goes in request order; boxes are kept for every instance.
- **Cover rank:** deterministic over classified photos: cover score, then quality, then fewer issues, then upload order (1 = best).
- **Privacy status per photo** (precedence top-down): `failed` (a privacy call failed: the photo is **not** privacy-checked), `review` (SAM found nothing for a phrase Spark reported visible), `masked` (regions found; their masks are stored), `clear`. Export (P3-09) may publish only `clear` and `masked` photos without a human decision, blurring the stored masks (boxes are in stored-photo pixels).
- **Errors:** a photo-level failure (unparseable or truncated Spark answer, malformed SAM output, a non-retryable 400/413/415/422) is stored on that photo (`classification.status: failed` or a failed privacy phrase / evidence request) and the step continues, because a step retry would fail the same way and re-pay every other photo. Everything else (429/5xx after SDK retries, timeouts, abort, budget, pricing) propagates to the engine's transient/non-retryable split; after the first such error no new call starts and in-flight calls are awaited. If every photo's classification, or every photo's privacy check, fails, the run fails (`NonRetryableStepError`). There is no in-step retry layer.
- **Output:** one `photo_inventory` artifact (`photoInventoryContentSchema`: settings, counts, evidence cap usage, and per photo the classification, privacy results with regions and masks, and observations with their evidence status, regions, and fact region) and one `photo_region` candidate fact per observation: key `other:<object>`, value = SAM's instance count when segmented, else Spark's count, `unit`/`basis` null, `assertion: stated`; region = union of the SAM boxes, else the whole photo; `maskArtifactId` = the inventory artifact when masks exist (the masks are those of the observation with the fact's key in the photo with the fact's `materialId`). An observation SAM was asked about and did not find (`not_found`) gets no fact. A `photos_inventoried` event carries counts only.
- **Idempotency:** `commit` inserts the artifact and facts only if the step has no `photo_inventory` yet. It runs inside the engine's completion transaction (run row locked, claim re-checked, at most one completed attempt per step), so this check is serialized; `photo_inventory` is not in the singleton index (no migration).
- **Reconciliation input (P2-09):** `photos[].room` = subject, `summary`, observations → `Pnn.Rk` with label + detail; `supports` links an object to profile facts (e.g. `balcony → outdoor_space` in `international`, `energy_label → energy_label` in `nl`). Cross-photo aggregates (distinct bedrooms) are not produced here.

**Model and effort defaults (P1-03).** The efforts above are the service-definition defaults (§7), chosen from measurements on a reconciliation-sized synthetic input (~4.3k input tokens, four planted defects) and one verification-sized call; details in [model-notes.md](./model-notes.md#p1-03--wonder-10-cost-and-latency).

- Wonder `low` caught every planted defect in reconciliation ($0.076, 13.7 s) and verification ($0.05, 12.5 s). `medium` (+25% cost) and `high` (+70%) added nothing and produced slightly messier output, so judgment steps start at `low`.
- Spark `medium` matched Wonder on reconciliation at 46% of the cost but 60% more latency (6× the reasoning tokens). It is the fallback for both judgment steps, and promoting it to primary is a definition change if the budget tightens.
- Spark steps (extraction, classification, Q&A) use `low`. Creative copy uses `medium` because a segment that fails the validator or verifier costs a revision loop (~$0.08). P3-01 confirms this setting with the validator pass rate.
- Every step sets `max_output_tokens` at about 4× its expected output, so one runaway reasoning call cannot consume the run budget. Exception, measured in P2-07: fact extraction answers with ~4.4k tokens on a 3-minute walkthrough after ~4–5.5k reasoning tokens at `low`, so 8,000 truncated the answer; it is 14,000 (~1.7× the measured 8.4k, worst case $0.062 per call).
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
      transcription_mode: DIARIZATION
      max_turn_seconds: 30
    - id: fact_extraction
      agent: extractor
      model: muse-spark-1.3
      reasoning_effort: low
      max_output_tokens: 14000
    - id: vision_inventory
      agent: vision
      model: muse-spark-1.3
      reasoning_effort: low
      max_output_tokens: 4000
      segmentation_model: sam-3.1
      max_evidence_masks: 12
      privacy_phrases: [person, license plate]
      classification_long_edge_px: 1024
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
    max_cost_usd_per_run: '1.00'
```

- Steps are a union on `agent` (`intake`, `extractor`, `vision`, `reconciler`, `creative`, `qa_writer`, `integrity_checker`, `verifier`, `exporter`); each agent allows only its own fields. Buyer Q&A is its own step, so cut level 1 removes one entry.
- Every model ID (`model`, `fallback_model`, `segmentation_model`, `image_model`) must exist in `PRICE_TABLE`, so an unpriced model fails at boot rather than at the first call. `-contributor` IDs are rejected.
- Language-model steps require `reasoning_effort` (validated by `metaReasoningEffortSchema`, the same set for Spark and Wonder) and `max_output_tokens` (bounds the worst-case reasoning cost of one call; per photo in vision inventory). Efforts are rejected on models not billed per token. `fallback_model` must differ from `model` and requires `fallback_reasoning_effort`.
- Step IDs, input keys, and gates are unique; `gate_after` is a known gate.
- The vision step requires `max_evidence_masks` (0–100: per run, the cap on SAM evidence requests and on stored evidence masks), `privacy_phrases` (1–5 unique SAM noun phrases, segmented on every photo, uncapped), and `classification_long_edge_px` (256–4096: Spark's input resolution). Phrases are validated like `assertSamPhrase` (`samPhraseSchema`: one noun phrase, ≤ 80 characters, no list or token characters). The last two were added to `listing-launch` v1 in place in P2-08, before any run existed.
- The intake step requires `transcription_mode` (`ENDPOINTING` or `DIARIZATION`; `PUSH_TO_TALK` returns no turns and is rejected) and takes an optional `max_turn_seconds` (5–600; omitted = turns are never split). Both were added to `listing-launch` v1 in place in P2-06, before any run existed.
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
  transcription_keywords: [NEN 2580, gebruiksoppervlakte, woonkamer, meterkast, vlizotrap, ...]
```

- Fact types: `enum` (`values`), `area` (`basis`), `volume`, `integer` (`min`/`max`), `money`, `boolean`. Facts are scalar so the form and the Fact Sheet stay flat; ground lease is two facts rather than an object. `required` defaults to `false`; `label` feeds the generated form.
- Area facts carry a basis listed in `area_bases`; their unit is `units.area`. Volume facts need `units.volume`, money facts need `currency`.
- Checklist rules: `fact_present` (references a known fact), `staged_images_labeled`, `no_flagged_phrasing` (category listed in `flagged_phrasing`). Phrasing categories are a closed set because the verifier implements each.
- Languages are known ISO 639-1 codes; `default_output_language` must be in `output_languages`. Fact keys, basis IDs, checklist IDs, and enum values are unique.
- `transcription_keywords` (optional, default empty, at most 50 unique terms of up to 64 characters): room and building terms in the source languages that bias Voice Transcribe. Fact labels contribute their parenthesised local term automatically, so it is not repeated here. Added to `nl` v1 in place in P2-06 (before any run existed); `international` v1 has none.
- `evidence_objects` (optional, default empty, at most 40): `{ id, label, phrase, supports? }` in priority order. `id` is a snake_case key (not `other`) used as the photo fact key `other:<id>`; `label` is what Spark looks for (may carry local terms); `phrase` is the SAM prompt; `supports` lists profile fact keys the object can support. IDs and phrases (case-insensitive) are unique; `supports` must name profile facts. Added to `nl` v1 (19 objects, energy label first) and `international` v1 (18, balcony/terrace → `outdoor_space`, garage → `parking`) in place in P2-08. `door` is deliberately absent (SAM matches cupboard doors, P1-05).
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
- `run_steps` — the run engine's idempotency record (P2-03, §9): one row per run, step, and attempt (primary key `(run_id, step_id, attempt)`; the attempt increases only when a failed run resumes). Columns: status (`queued | running | completed | failed`), the pg-boss `job_id` created for the attempt in the same transaction, `job_retry_count` of the delivery holding the claim, `executions` started, an operator-safe `error`, `output_artifact_ids`, `gate_released_at` (set when the run is resumed past the step's `gate_after`), and start/finish times.
  - Partial unique indexes make the engine's guarantees database invariants: at most one `completed` attempt per run and step (`run_steps_one_completion_key`), and at most one `queued`/`running` attempt (`run_steps_one_open_attempt_key`). Checks: `finished_at` is set exactly for closed attempts, `failed` requires `error`, and a gate can only be released on a completed step.
- `run_events` — append-only event log per run, primary key `(run_id, seq)`. `seq` is gapless and strictly increasing per run: it comes from incrementing `runs.last_event_seq`, which row-locks the run, so concurrent appends serialize and commit in order. `occurred_at` defaults to `clock_timestamp()` so events in one transaction keep distinct times for replay. A trigger rejects direct UPDATE and DELETE; deletes cascading from `runs` are allowed. Event types are an app-validated text set (`RUN_EVENT_TYPES` in `packages/shared`), so new types need no migration.
- `facts` — per run: key, value (JSON), unit, measurement basis, producing step, provenance (`source_kind`: `form | transcript_turn | photo_region`, plus `source_ref` JSON: form field; transcript artifact ID + turn index + start/end ms + the verbatim `quote`; or photo material ID + normalized region + optional mask artifact ID), status (`candidate | verified | conflicted | rejected`), assertion (`stated | opinion`, default `stated`; migration `0004`).
  - Keys are a market profile fact key or `other:<snake_case>` (non-core); area facts carry a profile basis or `unspecified`, other facts no basis (P2-07, §5).
  - The check `facts_opinion_never_verified` (`assertion = 'stated' or status <> 'verified'`) makes "an opinion is never a verified fact" a database invariant.
- `artifacts` — generated outputs per run and step: kind (open snake_case set), JSON content and/or a stored file (storage key + MIME type), and the `usage_ledger` IDs of the model calls that produced them.
  - Singleton kinds (`SINGLETON_ARTIFACT_KINDS`: `transcript`, `fact_extraction`) are unique per run, step, and kind by the partial index `artifacts_singleton_kind_key` (migration `0003`, extended in `0004`). `insertSingletonArtifact` inserts with `ON CONFLICT DO NOTHING` and returns the existing row otherwise, so a repeated commit keeps the first transcript that facts cite.
  - `transcript` content (P2-06): `transcriptArtifactContentSchema` (§5 Intake). Transcript text is personal data and cascades with the project.
  - `fact_extraction` content (P2-07): `factExtractionReportSchema` (§5 Fact extraction). Its rejected items quote model output and transcript spans, so it has the same personal-data scope.
  - `photo_inventory` content (P2-08): `photoInventoryContentSchema` in `packages/shared/src/vision.ts` (§5 Vision inventory): per photo the classification, cover rank, privacy results (boxes in stored-photo pixels, normalized regions, `one_bit` mask payloads), and observations with evidence regions. Model text about the property, so it cascades with the project like the transcript.
- `claims` — one row per copy segment: artifact, segment index, text, fact IDs exactly as cited (text array, no FK, so the validator can record and reject unknown IDs), validator result (`pass | fail`) + details, verifier verdict (`supported | unsupported | flagged`) + details.
- `decisions` — human gate decisions: gate (`fact_conflicts | claim_audit`), target (`fact | claim | artifact` + ID), choice (`accept | edit | remove | reject`), edited value (required exactly for `edit`), decided by, decided at. One decision per target per gate. `recordDecision` refuses unless the run is currently awaiting that gate and the target belongs to the run.
- `usage_ledger` — one row per model call: model ID, step, input/output/reasoning tokens, audio seconds (`numeric(10,3)`), images, estimated cost in USD (`numeric(12,8)`, exact decimal strings end to end — never floats), latency, run (nullable for calls outside a run).

**State columns** use Postgres enums generated from `as const` tuples in `packages/shared` (one source for the DB, API, and web; erasable-TS compatible). Open taxonomies that the pipeline extends (run event types, artifact kinds) are text validated in code.

**Deletion:** every project-derived row cascades from `projects` (and `projects` from `users`), so deleting a project hard-deletes its materials, runs, run steps, events, facts, artifacts, claims, and decisions in one statement; `deleteProject` returns the storage keys so the caller removes the files. `usage_ledger` is the exception: its `run_id` is set to NULL. Ledger rows contain no customer content (model ID, unit counts, cost, latency), and keeping them stops a deleted project from erasing spend from the global daily cap.

**Uploads and storage (P2-05).** Code: `apps/api/src/storage/` (`Storage` interface, `createLocalStorage`), `apps/api/src/media/` (`image.ts`, `audio.ts`, `probe.ts`, plus the P1-04 `convert.ts`), `apps/api/src/uploads/process-upload.ts`. No HTTP endpoint yet; P4-03 adds the route (ownership check, multipart into a temp file) and calls `processUpload`.

- **Storage:** `put(key, bytes | stream) → { key, sizeBytes, sha256 }`, `get(key) → stream` (`StorageNotFoundError`), idempotent `delete`, `exists`. Keys are opaque and server-generated (`projects/<projectId>/materials/<uuid>.<ext>`), restricted to lower-case `/`-separated segments that cannot start with `.`, and checked again against the root after path resolution, so traversal is impossible. Writes go to `<root>/.tmp/<uuid>` (mode 0600), are fsynced, renamed into place, and the directory is fsynced: an object is either absent or complete. The local implementation is rooted at `STORAGE_DIR` (absolute; required in production, where it is the `/data` volume; `<repo>/data/storage` otherwise). `delete` removes the file permanently, which P5-04 uses with the keys `deleteProject` returns; empty directories are left in place (their names are UUIDs).
- **`processUpload({ projectId, kind, tempFilePath, clientMime? })`:** validate and process → `storage.put` → `addMaterial` (`processing`, stored size and SHA-256) → `ready` with metadata. It owns the temp file and deletes it, and every intermediate file, on every path. Invalid uploads throw `UploadRejectedError` with a code (`UPLOAD_REJECTION_CODES` in `packages/shared`) and an uploader-safe message; nothing is stored and no row is written, because a row needs a stored file. A failure after storing deletes the file; if the row already exists, it becomes `failed` with `{ failureReason }`. `clientMime` is never used for validation.
- **Photos (sharp):** limits in `UPLOAD_LIMITS` (25 MiB, 100 MP, long edge 2048 px). The container is identified by magic bytes before any decoder runs (JPEG, PNG, WebP), so libvips never parses SVG, PDF, TIFF, or GIF; sharp's header metadata must agree. The pixel count is checked on the header and enforced again by `limitInputPixels` during decoding (decompression bombs); `failOn: 'error'` rejects corrupt and truncated files. Then: auto-orient by EXIF, downscale to fit the long edge (never enlarge), flatten transparency onto white, convert to sRGB through the embedded ICC profile, and encode JPEG (quality 85, mozjpeg). sharp writes no metadata unless asked, so the output has no EXIF (incl. GPS), XMP, IPTC, comments, or ICC profile; a test builds a JPEG with GPS EXIF, XMP, orientation, and a P3 profile and checks both sharp's reader and the raw JPEG segments. **JPEG over WebP:** listing portals and every export target accept JPEG, the vision models take it, and the size difference at 2048 px is small.
- **HEIC is rejected** (`heic_not_supported`): sharp's prebuilt libvips includes libheif with the AV1 decoder only (HEVC is patent-encumbered), so it reads AVIF but not iPhone HEIC (verified in sharp 0.35.5: `sharp.format.heif` lists only `.avif`). The web app converts photos on the device during client-side downscaling (P4-03); iPhones set to "Most Compatible" upload JPEG anyway. AVIF is refused too, as it is not an accepted format.
- **Voice memos (ffmpeg):** limits 128 MiB (10 minutes of 48 kHz stereo WAV) and 600 s. `ffprobe` (argument array, `shell: false`, 15 s timeout, `-protocol_whitelist file`, `-format_whitelist` of the accepted demuxers) validates the container (MP4/M4A, WebM/Matroska, Ogg, WAV, MP3, FLAC, ADTS AAC, AMR), exactly one audio stream with an allow-listed codec, and no real video stream (cover art is allowed). A declared duration over the limit is rejected before decoding. Browser-recorded WebM declares no duration and headers can be forged, so the shared converter now takes `maxDurationMs` (ffmpeg `-t`), set to limit + 1 s: decoding work and WAV size stay bounded, and the measured WAV duration decides `too_long`. The converter also passes `-protocol_whitelist file`. The 16 kHz mono 16-bit transcription WAV is what is stored.
- **Originals are not kept** (data minimization): they carry GPS and device metadata, and nothing downstream needs them. The trade-off is that changing processing settings later requires a re-upload.

## 9. Runs, jobs, and reliability

Code: `apps/api/src/runs/` (`engine.ts`, `queue.ts`, `steps.ts`, `worker-runtime.ts`), `apps/api/src/db/repositories/run-steps.ts`, event payloads in `packages/shared/src/run-events.ts` (P2-03).

- **Steps are jobs.** Each step attempt is one job on the pg-boss queue `run-step` (policy `exclusive`). The idempotency key `run_id:step_id:attempt` is the job's `singletonKey`, so pg-boss rejects a duplicate enqueue while the attempt's job is created, retrying, or active (`send` resolves `null`). The `run_steps` row (§8) is the authority: it records the job ID created for the attempt, and only that job may execute it.
- **Transactional enqueue.** Every state change and the enqueue it implies commit in one database transaction: jobs are sent with `boss.send(..., { db: fromDrizzle(tx, sql) })` (pg-boss 12's Drizzle adapter, verified against 12.38), so a rollback removes the job too. `startRun`, `resumeRun`, and `resumeAfterGate` accept the caller's transaction (`{ tx }`), so e.g. Gate 1 (P2-10) can record the last decision and resume in one transaction.
- **What comes next is derived from the database, never from memory.** `advance` walks the definition's steps against the completed `run_steps` rows: the first completed step with an unreleased `gate_after` opens the gate (`running → awaiting_gate` plus `gate_opened`); otherwise the first step without a completed attempt is enqueued (new `run_steps` row, job, `runs.current_step_id`); otherwise the run completes. Because the gate release is stored on the step, a run that fails at a gate and is resumed stops at the same gate again.
- **Claim, execute, settle.** A delivery first _claims_ the attempt in a transaction that locks the run row and then the step row (the same order everywhere, so workers serialize per run instead of deadlocking). It is skipped without executing when the run is gone or not `running`, the job is not the attempt's job, the attempt is completed or closed, or a delivery with the same or a newer `retryCount` already holds the claim. Otherwise `executions` is incremented and `step_started` appended. The handler runs outside any transaction. On success one transaction re-checks that this delivery still holds the claim, runs the handler's `commit(tx)` (its artifacts and facts), marks the attempt completed, appends `step_completed`, and calls `advance`. A superseded execution (its claim was taken over after pg-boss expired it) therefore can neither write its output nor complete, fail, or advance the run.
- **Step contract.** Handlers are registered by `agent` (`StepHandlers`) in `worker.ts` (`intake` since P2-06, `extractor` since P2-07, `vision` since P2-08; the others arrive with their tasks), and a step whose agent has no handler fails the run with a clear reason. Handlers that need more than the context (storage, the market registry) are built by factories such as `createIntakeHandler({ storage, markets })`. `StepContext` carries the run, the service definition, the step's own typed configuration, attempt and execution numbers, the database for reads, a `StepLedger` (`meter`, `checkBudget`), a lazy `metaClients()` bound to this execution's ledger, a logger, and an `AbortSignal`. One usage ledger and one set of Meta clients are built per execution. The ledger refuses new calls after the signal aborts, and is flushed after the handler as a safety net for calls made outside `meter`.
- **Timeouts and abort.** Each execution gets the engine's step timeout (default 10 min, configurable per step). The signal aborts on that timeout, on worker shutdown, and when pg-boss loses the job's claim. The engine stops waiting at once, even if the handler ignores the signal. The job's `expireInSeconds` is the timeout plus 60 s, so the engine always times out first. Jobs carry `heartbeatSeconds: 30`: pg-boss fails the job of a crashed worker 30 s after its last heartbeat, plus one supervise pass of up to 60 s, instead of waiting for expiry. Workers poll every 2 s, also on notify-enabled queues. NOTIFY wakes workers only for new jobs, and the 30 s default backstop would otherwise delay every retry.
- **Retry policy.** An attempt allows two executions (`MAX_STEP_EXECUTIONS`).
  - A transient failure (unknown error, timeout, interruption, a crash) puts the attempt back to `queued`, appends `step_failed` with `willRetry: true`, and throws a sanitized `StepRetryError` so pg-boss retries the job (`retryLimit: 2`, `retryDelay: 5 s`).
  - `BudgetExceededError`, `UnpricedModelError`, `UnpricedUsageError`, a missing definition, and `NonRetryableStepError` fail the run at once.
  - A second failure fails the run: `step_failed` with `willRetry: false`, open attempts closed, and `running → failed` with a reason such as `Step "b" failed after 2 executions: Step "b" timed out after 600 s`.
  - A crash counts as an execution, because the step may already have spent money. When both executions started and neither settled, the next delivery fails the run instead of executing again; the third pg-boss delivery exists for exactly that case.
  - Jobs that still exhaust pg-boss retries land in `run-step-dead`, whose handler fails the run, so a run never stays `running` without a job.
  - `resumeRun` (`failed → queued → running`) skips completed steps and gives the failed step a new attempt.
- **Operator-safe reasons.** Failure reasons, `step_failed` payloads, logs, and the error stored on the pg-boss job use the message only for errors whose text this codebase controls (timeouts, budget, pricing, `NonRetryableStepError`). Any other error is reduced to its class name (`Unexpected TypeError`), because SDK errors can carry request bodies and validation errors can quote model output.
- **Run events** for SSE and replay (payloads in `packages/shared/src/run-events.ts`, IDs, counters, and exact decimal costs only):
  - `step_started` `{ stepId, attempt, execution }`;
  - `usage_recorded` `{ stepId, stepCostUsd, runCostUsd }` after every metered call;
  - `step_completed` `{ ..., artifactIds, stepCostUsd, runCostUsd }`;
  - `step_failed` `{ ..., reason, willRetry, stepCostUsd, runCostUsd }`;
  - `gate_opened` `{ gate, stepId }`;
  - `transcript_stored` `{ stepId, artifactId, mode, audioDurationMs, sourceTurnCount, turnCount, approximateTurnCount, speakerCount, keywordCount }` from the intake step's commit (counts only, never text or keywords);
  - `facts_extracted` `{ stepId, artifactId, formFactCount, modelFactCount, transcriptFactCount, opinionCount, repairedCount, rejectedCount }` from the fact extraction step's commit (counts only, never keys, values, or quotes);
  - `photos_inventoried` `{ stepId, artifactId, photoCount, classifiedCount, classificationFailedCount, privacyClearCount, privacyMaskedCount, privacyReviewCount, privacyFailedCount, privacyRegionCount, observationCount, evidenceRequestCount, evidenceMaskCount, factCount }` from the vision inventory step's commit (counts only, never subjects, summaries, or object names);
  - plus `run_status_changed` from `transitionRun`.
  - Step cost covers every ledger row of the step across attempts and executions.
- **Graceful shutdown.** On SIGTERM/SIGINT the worker stops fetching, gives in-flight steps up to 25 s to finish (a step that finishes commits its completion and enqueues the next step for another worker), then pg-boss fails and aborts what is left; those jobs are retried after restart. The database pool closes after pg-boss. A second signal terminates immediately. The compose `worker` service needs a `stop_grace_period` above 25 s; Docker's default of 10 s cuts the grace period short, and the affected steps are then recovered like a crash.
- **Proven by tests.** `apps/api/src/runs/crash.integration.test.ts` runs the real worker runtime in a child process with fake handlers. It SIGKILLs the worker during a slow step, after the first step has completed, and restarts it. The run then completes with each completed step executed exactly once, the interrupted step executed twice, and one ledger row per invocation; pg-boss re-delivers the job about 11 s after the kill (heartbeat 10 s in the test). The same file covers graceful shutdown. `engine.integration.test.ts` covers gates, transactional enqueue with rollback, retry and failure policy, resume, budget and timeout failures, duplicate enqueues, concurrent and superseded deliveries, two workers sharing the queue, and the dead-letter handler.
- If Wonder is unavailable, judgment steps fall back to Spark and the result is labeled as such (P2-09).

## 10. Cost controls

Measured unit costs. Every figure is list price × the units the API reported; Meta's billing dashboard was never checked. Details and request shapes: [model-notes.md, Summary](./model-notes.md#summary).

| Item             | List price (Standard mode)                                       | Measured unit cost (source)                                                                                                                                                                                                                                                                                                                                                                                                                            | Per-run share, typical (10–20 photos)                                                     |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Spark 1.3        | $1.25 in / $4.25 out per 1M tokens                               | Fact extraction at `low`: $0.038 for a 2:49 walkthrough, with 2.1k in and 8.4k out (4.0k of it reasoning), ~25 s; $0.062 at the 14k cap (P2-07). Classification at `low` on a 1024-px copy: $0.0056–0.0073 per photo, mean $0.0064, with 2.0k in and 0.7–1.1k out, ~4 s; a 2048-px photo cost $0.012 (P2-08). Reconciliation fallback at `medium`: $0.035, 22 s (P1-03). At the API default effort `high`, ~95% of a short answer is reasoning (P1-01) | $0.14–0.21, of which copy ~$0.03 at `medium` and Q&A ~$0.01 at `low` are **extrapolated** |
| Wonder 1.0       | $4.00 in / $20.00 out per 1M tokens (reasoning billed as output) | Reconciliation at `low`: $0.076 for 4.3k in (24 candidates, 12 photos), 0.9k reasoning, 14 s; $0.095–0.098 at `medium`; $0.129 at `high`. Verification at `low`: $0.050 for 2k in (26 segments), 13 s (P1-03). The ~2k-token answer, not the reasoning, dominates at `low`                                                                                                                                                                             | $0.13; ~$0.18 if reconciliation scales with P2-07's catalog (**extrapolated**)            |
| Voice Transcribe | $0.18 per audio hour                                             | $0.0084 for 168.8 s of billed audio, ~33 s latency (P1-04, P2-06)                                                                                                                                                                                                                                                                                                                                                                                      | $0.01; $0.03 at the 10-minute maximum                                                     |
| Muse Image       | $0.01 per image                                                  | Flat per returned image; the reported tokens (10–21k in) are informational. Edits take 8–16 s. Customer photos go through the `openai` JSON edit body with every tool off (P1-06, P1-08)                                                                                                                                                                                                                                                               | $0.03 (3 staged images)                                                                   |
| SAM 3.1          | $2.50 per 1,000 images                                           | $0.0025 per call, empty results included, 0.6–1.7 s (P1-05). Vision: 2 privacy calls per photo plus at most 12 evidence calls per run (P2-08). Integrity: 3 calls per original (reused across variants and retries) plus 3 per checked edit (P1-07)                                                                                                                                                                                                    | $0.13–0.18 ($0.08–0.13 vision, $0.045 integrity)                                          |

### Per-run estimate (P1-08)

Assumptions:

- **Typical run:** a 3-minute memo, 3 staged images (each from a different original, no integrity retry), one verification pass, and no fallback.
- **Worst case:** 30 photos, a 10-minute memo, 6 staged images each retried once, and two full revision loops. Each loop re-runs copy, Q&A, and verification.

| Step                           | 10 photos | 20 photos | Worst case, 30 photos | Basis                                                                                |
| ------------------------------ | --------- | --------- | --------------------- | ------------------------------------------------------------------------------------ |
| Intake (Voice)                 | $0.010    | $0.010    | $0.030                | measured per second                                                                  |
| Fact extraction (Spark `low`)  | $0.038    | $0.038    | $0.062                | measured; worst = 14k cap                                                            |
| Vision: Spark classification   | $0.064    | $0.128    | $0.219                | measured mean; worst = measured max $0.0073 per photo                                |
| Vision: SAM privacy + evidence | $0.080    | $0.130    | $0.180                | measured                                                                             |
| Reconciliation (Wonder `low`)  | $0.076    | $0.076    | $0.130                | measured on a 24-candidate catalog; worst **extrapolated** to P2-07's ~70 candidates |
| Creative copy (Spark `medium`) | $0.030    | $0.030    | $0.090                | **extrapolated**; worst = 3 generations                                              |
| Buyer Q&A (Spark `low`)        | $0.010    | $0.010    | $0.030                | **extrapolated**; worst = 3 generations                                              |
| Staging (Muse Image)           | $0.030    | $0.030    | $0.120                | measured; worst = 12 images                                                          |
| Integrity (SAM)                | $0.045    | $0.045    | $0.135                | measured; 18 calls typical, 54 worst                                                 |
| Verification (Wonder `low`)    | $0.050    | $0.050    | $0.150                | measured; worst = 3 passes                                                           |
| **Total**                      | **$0.43** | **$0.55** | **~$1.15**            |                                                                                      |

- **Run cap: $1.00 (raised from $0.50 on 28 Oct, after P1-08).** At $0.50 a 20-photo run did not fit: it costs ~$0.55 at the measured reconciliation cost and ~$0.60 if reconciliation grows with a P2-07-sized catalog (~$0.13, extrapolated). The break-even was about 15 photos, or 11 with the extrapolated reconciliation; each photo adds $0.0114 ($0.0064 Spark, $0.005 SAM).
  - At $1.00 a 30-photo typical run (~$0.67) fits, with ~$0.30–0.45 of headroom for revision loops and integrity retries.
  - The ~$1.15 worst case still stops at the cap. Steps run in order and the cap is checked before each call, so such a run ends in the late steps (staging, integrity, or verification revision loops).
- **Worst case:** ~$1.15 in expected tokens. Every step at its output cap would cost more: vision alone $0.77, reconciliation $0.28. Such a run stops at the run cap. It overshoots by at most the calls already in flight, which is up to 4 vision calls, a few cents.
- **Daily cap ($5.00 by default):** 10–11 typical 10-photo runs or about 9 typical 20-photo runs, but only 5 runs that hit the $1.00 cap. Raise `DAILY_BUDGET_USD` for a demo day with many live runs.
- **Further levers (not applied):** each needs a definition change and, for model settings, a re-recording.
  1. ~~Raise the run cap to $0.75.~~ Superseded: the cap is $1.00.
  2. **Spark `minimal` for classification.** This saves roughly the reasoning share, ~$0.003 per photo, or ~$0.06 at 20 photos. The quality impact is unmeasured; a re-recording of the six samples costs ~$0.04.
  3. **Lower the vision `max_output_tokens` from 4,000 to 2,000.** The typical cost does not change, because the measured maximum is 1,137 tokens. The worst case per photo halves, from $0.0195 to $0.011, and Spark at 30 photos drops from $0.59 to $0.33.
  4. **Run `license plate` only on exterior photos.** This saves $0.0025 per interior photo, ~$0.04 at 20 photos. The privacy calls would then have to wait for classification (today they run in parallel). It also weakens the rule that every photo is checked for every phrase, and a misclassified exterior photo would skip the plate check.
  5. **Promote Spark `medium` to primary for reconciliation.** This saves ~$0.04 per run (measured) at +60% latency.

  Levers 2 and 4 together bring a 20-photo run to ~$0.45. Two design choices in upcoming tasks also cut the worst case:
  - re-verifying and regenerating only the revised segments in P3-06, about $0.01–0.02 per loop instead of $0.08;
  - reusing the vision step's SAM results for the originals in P3-05.

- **Cached tokens:** Meta reports `cached_tokens` for a repeated prompt prefix (4.2k of 4.3k on an identical request). No cached rate is documented, so every estimate bills them at the full input price.

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
| E2E         | Playwright                                | Auth (register, logout, redirect, login); capture → run → gates → export against the stack in replay mode; production smoke test                                               |
| Evaluation  | `npm run eval`                            | Seeded-defect property sets: catch rate for planted conflicts and unsupported claims. Fixture mode is free; live mode is run deliberately and logged.                          |

Fixtures are recorded from real calls in Phase 1 (`RECORD=1`) and must not contain personal data.

Local e2e (`npm run test:e2e`) starts the API on :4000 (`npm run start -w @evidomo/api`, environment passed by `playwright.config.ts`, no `.env` file) and the web dev server on :3000, and needs a migrated local PostgreSQL (`npm run db:up && npm run db:migrate`; `E2E_DATABASE_URL` overrides the default local URL). Specs that create accounts skip themselves when `E2E_BASE_URL` points at a deployment. CI does not run e2e yet.

## 13. Deployment

- One Linode VPS in an EU region running Docker Compose: `caddy`, `web` (`next start`), `api`, `worker`, `postgres`. The API/worker image includes ffmpeg.
- Caddy terminates HTTPS automatically; the domain's DNS (Squarespace) points to the VPS.
- Firewall allows only 22, 80, 443; deploys run as a non-root user.
- Secrets live in a server-side `.env` (mode 600), never in the repository. `MODEL_API_KEY` is available only to `api` and `worker`, never to the browser.
- Deploy script: pull, build, migrate, restart, smoke test. Daily `pg_dump` to the volume.
- Images are built on the server from the repository (no registry). `apps/api/Dockerfile` builds one image for api and worker (production dependencies, sources run through type stripping, ffmpeg); its `migrate` target adds drizzle-kit for one-off migrations. `apps/web/Dockerfile` builds Next.js and runs `next start`. `infra/caddy/Dockerfile` bakes in the Caddyfile. All run as non-root users.
- `APP_ORIGIN` must be the public `https://` origin Caddy serves (api and worker refuse to start in production without it; §14).
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

**Authentication (P4-01).** Code: `apps/api/src/auth/` (`routes.ts`, `session.ts`, `password.ts`, `tokens.ts`, `rate-limit.ts`, `config.ts`), `apps/api/src/http/` (`guards.ts`, `errors.ts`); contracts in `packages/shared/src/auth.ts` and `api-error.ts`.

- **Endpoints** (JSON, under `/api/auth`, all `Cache-Control: no-store`). Errors are `{ error: ApiErrorCode, issues? }` (`apiErrorSchema`).
  - `POST /register` `{ email, password }` → 201 `{ user: { id, email } }` and the session cookie (registration logs in). 400 `validation_failed` (with `issues`), 409 `email_taken`, 429 `rate_limited`.
  - `POST /login` `{ email, password }` → 200 `{ user }` and a fresh cookie. 401 `invalid_credentials` for an unknown email and a wrong password alike (an unknown email still runs a dummy argon2 verification, so timing does not tell them apart). 429 `rate_limited`.
  - `POST /logout` (no body) → 204, deletes the presented session row and clears the cookie; idempotent, works without a session.
  - `GET /me` → 200 `{ user }` or 401 `unauthenticated`. The web app calls it to decide whether to redirect to login.
- **Passwords:** 12–256 characters (the maximum bounds hashing cost), NFKC-normalized, hashed with argon2id m=19456 KiB, t=2, p=1 (OWASP minimum). The algorithm is the library default because the `Algorithm` const enum is not erasable under type stripping; tests assert the `$argon2id$` prefix and parameters. Login does not re-apply the length policy.
- **Emails:** trimmed and lower-cased by the shared schema and the repository. A duplicate registration returns 409, which reveals that the address has an account; accepted for a small single-operator app.
- **Sessions:** a 32-byte `crypto.randomBytes` token, base64url, lives only in the cookie; `sessions.token_hash` stores its SHA-256 (hex). Expiry is **absolute** (`SESSION_TTL_DAYS`, default 30); there is no sliding renewal or idle timeout (an idle timeout would need a `last_seen_at` column). Login and registration always issue a new token and delete the session the request presented (rotation). An expired session is rejected by the database clock, its row deleted on that request, and the cookie cleared; a successful login also sweeps all expired rows.
- **Cookie:** `HttpOnly; SameSite=Lax; Path=/`, `Max-Age` = the session lifetime. When `APP_ORIGIN` is https, the cookie is `Secure` and named `__Host-evidomo_session` (pinned to the exact host, no `Domain`); over plain http (development, a local run of the production stack) it is `evidomo_session` without `Secure`. Production refuses an http `APP_ORIGIN` other than localhost.
- **CSRF:** besides SameSite=Lax, every state-changing `/api` request (anything but GET/HEAD/OPTIONS) whose `Origin` is present and not `APP_ORIGIN`, or that carries `Sec-Fetch-Site: cross-site`, gets 403 `forbidden_origin` before its body is read. JSON routers also use `requireJsonBody`: a state-changing request with a body must be `application/json` (415 `unsupported_media_type`), which excludes what HTML forms and no-preflight `fetch` can send. Malformed JSON is 400 `invalid_json`.
- **Rate limits** (in-process fixed windows; a restart resets them; memory bounded to 10,000 keys per limiter): login 50 per IP and 10 per account (keyed by the SHA-256 of the submitted email, existing or not, so a 429 reveals nothing; reset by a successful login) per 15 minutes; registration 20 per IP per hour. 429 carries `Retry-After` in seconds. The client IP is `req.ip` with Express `trust proxy` set to a hop count (`TRUST_PROXY_HOPS`: 1 in production, where Caddy discards client-supplied `X-Forwarded-For` and sets the real peer address; 0 elsewhere, so a direct client cannot choose its bucket).
- **Protecting routes:** `createSessionMiddleware({ db, config })` returns `requireUser` (401 `unauthenticated` JSON; the web app does the redirect) and `loadUser` (optional). Handlers read the user with `currentUser(req)` (typed `AuthUser = { id, email }`; throws, so 500, on a route not behind `requireUser`) or `optionalUser(req)`. State lives in a per-request `WeakMap`, not on an untyped `req` property. Project routes (P4-02 onwards) mount in `createApp` behind `session.requireUser` and check `projects.owner_id` against `currentUser(req).id`.
- **Logging:** user IDs only, never emails, passwords, tokens, cookies, or IPs. The HTTP error handler logs body-parser errors by type only (they carry the raw body) and reduces database errors to the SQL text and PostgreSQL code (`errorForLog`), because Drizzle's `DrizzleQueryError` embeds every bound parameter in its message.
- **Not here yet:** the access code for live runs and the per-account run limits are P4-10. Registration is public on the deployment; an account alone cannot start a live run once P4-10 lands.
- **Web side** (`apps/web/src/lib/auth.ts`, `components/AuthGate.tsx`, `pages/login.tsx`, `pages/register.tsx`):
  - `useMe()` (TanStack Query on `GET /api/auth/me`) is the only source of "who is signed in", because the cookie is httpOnly. A 401 resolves to `null`, not an error, so it is never retried; other 4xx are not retried either, network failures and 5xx twice. Login and register mutations write the returned user into the `me` cache; logout navigates to `/` first and then sets `me` to `null` and drops every other cached query.
  - Every response is parsed with the shared schemas (`authUserResponseSchema`, `apiErrorSchema`) by a small fetch helper (`lib/api.ts`, `credentials: 'same-origin'`, JSON `Content-Type` only on requests with a body). Errors become `ApiRequestError { status, code, issues, retryAfterSeconds }`; forms map `validation_failed` issues to fields by `path[0]`, `invalid_credentials` to one generic message, `email_taken` to an inline message with a login link, and `rate_limited` to the `Retry-After` wait.
  - **Guards** are opt-in per page: `Page.auth = 'required'` (signed-in only) or `'guest'` (login, register), read in `_app` by `AuthGate`; pages without the flag are public, which keeps the demo replay (§11) open to visitors. `required` renders a session check while `me` loads, never the content, and on `null` calls `router.replace('/login?next=<asPath>')` once the router is ready. `guest` sends a signed-in user to `next`, which also completes a successful login or registration. This is client-side gating for the user experience only; `requireUser` on the API is the enforcement.
  - **`next` validation** (`lib/next-path.ts`, prevents an open redirect): a string of at most 2,048 characters that starts with exactly one `/`, contains no backslash, control, or whitespace character (browsers turn `/\host` and `/<TAB>/host` into `//host`), resolves to the same origin, and is not `/login` or `/register`. Anything else falls back to `/`.
  - `/projects` is the protected signed-in landing page (an empty state until P4-02).
- **Environment:** `APP_ORIGIN` (the browser-facing origin, e.g. `https://evidomo.example`; default `http://localhost:3000`, required in production), `SESSION_TTL_DAYS` (1–365, default 30), `TRUST_PROXY_HOPS` (0–5; default 1 in production, 0 elsewhere).

## 15. References

Meta model cookbook (`github.com/meta-models/meta-model-cookbook`): `01_api_fundamentals` (structured output, vision, error handling), `02_agent_patterns` (validated in-place edits), `04_muse_code` (staged approvals, append-only audit log, deterministic replay in CI), `05_muse_image`, `06_muse_voice`, `07_sam`.
