# Model notes

Findings from the Phase 1 model spikes: request/response shapes, API constraints, measured costs,
and the decisions they drive. Each task owns its section; keep the headings stable so spikes can
fill them in parallel. Prices come from [architecture.md §10](./architecture.md#10-cost-controls).

## P1-01 — Meta client module

Status: done (pending review). Recorded 2026-10-28 against `ai@7.0.155`, `@ai-sdk/openai@4.0.104`,
`openai@7.45.1`, `msw@3.0.3`.

### Client setup

All code lives in `apps/api/src/meta/`:

| File          | Purpose                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `clients.ts`  | `createMetaClients()`: AI SDK provider + `openai` client, retry/timeout policy, usage hooks   |
| `usage.ts`    | `UsageEntry`, `UsageRecorder`, in-memory recorder, `CostEstimator` hook, usage parsers        |
| `fixtures.ts` | Fixture (cassette) schema, request match key, read/write                                      |
| `replay.ts`   | MSW record/replay switch. **Test-only** (imports the `msw` dev dependency); not in `index.ts` |
| `index.ts`    | Public surface for server/worker code                                                         |

- **Base URL** `https://api.meta.ai/v1`, `Authorization: Bearer <MODEL_API_KEY>` (both SDKs build
  the header themselves). Both SDKs get `apiKey`, `baseURL`, and (for `openai`) `organization:
null`/`project: null` explicitly, because they otherwise fall back to `OPENAI_*` env variables.
- **AI SDK provider**: `createOpenAI({ name: 'meta', ... })`. Language models are created with
  `clients.languageModel(id)`, which is `provider.responses(id)` (the Responses API). The provider
  ID is therefore `meta.responses`. Despite the provider name, the Responses model reads only
  `providerOptions.openai`; use `metaProviderOptions()` (corrected in P1-02).
- **Retries and timeouts — SDK settings only.** One policy (`maxRetries`, default 2;
  `timeoutMs`, default 180 s) feeds both SDKs:
  - `openai`: client options `maxRetries` and `timeout`. The timeout is **per attempt**. The SDK
    retries 408/409/429/5xx and connection errors, honors `Retry-After` and `x-should-retry`.
  - AI SDK: retries and timeout are **per call**, not provider settings, so every call spreads
    `...clients.aiSdkCallOptions()` (`maxRetries`, `timeout`, `onLanguageModelCallEnd`). A numeric
    `timeout` covers the **whole call including retries** (there is no per-attempt variant). The
    AI SDK retries 408/409/429/5xx with exponential backoff and honors `retry-after(-ms)`.
- **Late-bound fetch.** Both SDKs receive a `metaFetch` that calls `globalThis.fetch` per
  request. The `openai` SDK otherwise captures `fetch` in its constructor, which would bypass MSW
  if a client is built before interception starts.
- **Standard-mode guard in code.** `languageModel()` rejects `-contributor` IDs, and `metaFetch`
  rejects any JSON or multipart request whose `model` ends in `-contributor`, whichever SDK or
  call site built it. With the `openai` SDK the guard error surfaces as the `cause` of an
  `APIConnectionError` (the SDK wraps fetch failures, and retries them, so `maxRetries` attempts
  are made locally before it gives up; nothing reaches the network).
- **Logging.** `openai` SDK logs go to the injected pino logger at `warn` (never `console`, never
  request bodies). The SDK redacts credential headers itself.

### `MODEL_API_KEY` requiredness

`apps/api/src/env.ts`: **required when `NODE_ENV=production`** (api and worker fail at boot),
optional in `development`/`test`; an empty value counts as unset. `createMetaClients()` throws
`MetaConfigError` when the key is missing, so a dev process fails at the point it builds a live
client instead of on the first model call. Tests never need the key: replay mode sends the
placeholder `replay-placeholder-key`, and record mode requires the real key from the environment.

### Spark text call (Responses API)

Request built by the AI SDK (`generateText({ model: clients.languageModel('muse-spark-1.3'),
prompt, maxOutputTokens: 2048 })`) and by `openai.responses.create({ model, input, max_output_tokens
})`: `POST /v1/responses`. The two SDKs serialize the same prompt differently (the AI SDK sends an
`input` message array, `openai` sends a string), so they never share a fixture interaction.

Response (abridged from `fixtures/meta/p1-01/spark-text.json`):

```json
{
  "id": "resp_…",
  "object": "response",
  "status": "completed",
  "model": "muse-spark-1.3",
  "reasoning": { "effort": "high" },
  "store": true,
  "max_output_tokens": 2048,
  "output": [
    { "type": "reasoning", "id": "rs_…", "summary": [], "status": "completed" },
    {
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [{ "type": "output_text", "text": "…", "annotations": [], "logprobs": [] }]
    }
  ],
  "usage": {
    "input_tokens": 20,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens": 540,
    "output_tokens_details": { "reasoning_tokens": 515 },
    "total_tokens": 560
  }
}
```

Findings:

- **Default reasoning effort is `high`.** With no effort set, 515 of 540 output tokens (95%) were
  reasoning for a one-sentence answer. Every step must set its effort explicitly from the service
  definition, or Spark costs several times what the answer needs. (P1-02 verifies how effort
  passes through AI SDK provider options.)
- **`store` defaults to `true`.** The API keeps responses server-side unless the request sends
  `store: false`. Pipeline steps carry customer content, so they should send `store: false`
  (AI SDK: `providerOptions.openai.store = false` via `metaProviderOptions()`, confirmed in P1-02).
- **Reasoning is part of `output_tokens`** (`total = input + output`; 540 = 25 text + 515
  reasoning). Cost is `input × in-price + output × out-price`; reasoning is not added again.
- The reasoning output item has an empty `summary` and no encrypted content unless requested.

### Usage fields

| `UsageEntry` field  | AI SDK (`onLanguageModelCallEnd`)            | `openai` SDK (Responses / Chat Completions)                    |
| ------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `modelId`           | `event.modelId` (response model)             | `result.model`                                                 |
| `inputTokens`       | `usage.inputTokens`                          | `usage.input_tokens` / `usage.prompt_tokens`                   |
| `cachedInputTokens` | `usage.inputTokenDetails.cacheReadTokens`    | `input_tokens_details.cached_tokens` / `prompt_tokens_details` |
| `outputTokens`      | `usage.outputTokens` (includes reasoning)    | `usage.output_tokens` / `usage.completion_tokens`              |
| `reasoningTokens`   | `usage.outputTokenDetails.reasoningTokens`   | `output_tokens_details.reasoning_tokens` / `completion_…`      |
| `latencyMs`         | `performance.responseTimeMs` (incl. retries) | measured around the call (incl. retries)                       |
| `estimatedCostUsd`  | `CostEstimator` hook, `undefined` if unset   | same                                                           |

- `openai` SDK results are validated with zod before use; a malformed usage payload throws
  `UsageCaptureError` (an unmeasured call is treated as a failure). Missing usage is recorded as
  `undefined` counts, never as zero.
- **The AI SDK swallows errors thrown by `onLanguageModelCallEnd`** (`notify()` wraps callbacks in
  an empty `catch`). `UsageRecorder.record()` is therefore synchronous; the P2-04 ledger must
  buffer entries in memory and persist them after the SDK call returns, or entries will be lost
  silently.
- `createTokenPriceEstimator(prices)` is the cost hook used in tests. The real price table and the
  ledger arrive with P2-04.

### Fixture format

One JSON cassette per test file under `fixtures/meta/<task>/<name>.json`:

```json
{
  "formatVersion": 1,
  "cassette": "p1-01/spark-text",
  "recordedAt": "2026-10-28T01:13:03.418Z",
  "interactions": [
    {
      "request": { "method": "POST", "path": "/v1/responses", "bodySha256": "<64 hex>" },
      "response": {
        "status": 200,
        "headers": { "content-type": "application/json" },
        "body": { "type": "json", "value": {} }
      }
    }
  ]
}
```

- **Match key** = method + path (query sorted) + SHA-256 of the normalized body. JSON bodies are
  canonicalized (sorted keys), multipart bodies are reduced to their fields and file hashes (the
  random boundary would break matching; ready for P1-04), other bodies are hashed raw.
- **Stored:** no request headers or body at all, so the `Authorization` header can never be
  written. Response headers are allow-listed (`content-type` only). Bodies are stored as `json`,
  `text` (e.g. SSE streams), `base64` (binary), or `empty`.
- Only 2xx responses are stored, so a 429/5xx retried during recording never ends up in a
  fixture. Identical requests share one interaction (the latest recording wins), which keeps
  replay deterministic.
- Fixtures are validated with zod on load. `fixtures.test.ts` checks every cassette under
  `fixtures/meta/` for format and for credential patterns (`authorization`, `bearer`, `LLM|<id>|`).
- `fixtures/meta/` is in `.prettierignore`: files are generated by `JSON.stringify(…, null, 2)`.

### Replay and record

```ts
const replay = createMetaReplay({ cassette: 'p1-01/spark-text' });
beforeAll(async () => {
  await replay.start();
  clients = createMetaClients({ apiKey: replay.apiKey, usage, estimateCost });
});
afterEach(() => replay.assertAllMatched());
afterAll(() => replay.stop());
```

- **Replay (default):** no request reaches the network. A Meta request without a fixture gets a
  404 (`x-should-retry: false`, non-retryable in both SDKs) whose message names the request key
  and cassette; requests to any other host fail with a network error. Both are also collected in
  `replay.unmatched`, and `assertAllMatched()` fails the test even if the code under test caught
  the SDK error. A missing cassette fails `start()`.
- **Record:** `RECORD=1` forwards Meta requests to the live API and writes the cassette on
  `stop()` (overwriting it). Requests to other hosts are still blocked.

Record command (loads `.env` without printing it; run from the repo root):

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api spark-text
```

Re-recording spends credit and changes the fixture; do it only when a brief authorizes it.

### Live calls and cost (P1-01)

| Call                                   | Input tok | Output tok (reasoning) | Est. cost (USD) |
| -------------------------------------- | --------- | ---------------------- | --------------- |
| Spark via AI SDK, default effort       | 20        | 540 (515)              | 0.00232         |
| Spark via `openai` SDK, default effort | 20        | 596 (571)              | 0.00256         |
| **Total (2 calls)**                    | 40        | 1,136 (1,086)          | **0.00488**     |

Both calls together took about 7.4 s of test time (roughly 3–4 s each at default effort `high`).
The record-mode mechanics were proven first against a local HTTP stub (`replay.test.ts`), so no
credit was spent on debugging.

## P1-02 — Spark 1.3: text, vision, structured output

Status: done (pending review). Recorded 2026-10-28 against the same pinned versions as P1-01
(`ai@7.0.155`, `@ai-sdk/openai@4.0.104`, `openai@7.45.1`).

### Reasoning effort and `store` through the AI SDK

Read from `@ai-sdk/openai`'s `OpenAIResponsesLanguageModel.prepareRequest` and proven with request
captures (`options.test.ts`) and live calls:

- **The provider-options key is `openai`, not `meta`.** The Responses model resolves its options
  key as `config.provider.includes('azure') ? 'azure' : 'openai'`, whatever `name` the provider was
  created with. Options under `providerOptions.meta` are **dropped silently** (no warning, neither
  `reasoning` nor `store` reaches the request). This corrects the P1-01 assumption above that
  `meta` is read first.
- **`forceReasoning: true` is required.** The SDK only treats `o*` and `gpt-5+` IDs as reasoning
  models. For `muse-spark-1.3` it drops `reasoningEffort` with the warning "reasoningEffort is not
  supported for non-reasoning models". With `forceReasoning: true` the effort is sent verbatim.
- **No client-side enum check.** The Responses options schema types `reasoningEffort` as
  `z.string().nullish()`, so any value (including `max` and invalid ones) reaches Meta. The top-level
  `generateText({ reasoning })` option is gated the same way (needs `forceReasoning`).
- **Side effects of `forceReasoning`:** `system` messages go out as role `developer` (Meta honours
  it: a developer "answer in uppercase" instruction was followed), `temperature`/`topP` are stripped
  with a warning, and whenever an effort is set the SDK adds `reasoning.summary: "detailed"` unless
  `reasoningSummary: null` is passed. Meta echoes the summary setting but returns `summary: []`.
- **`store: false` passes through** under the `openai` key and Meta echoes `"store": false`. On a
  reasoning model the SDK then also adds `include: ["reasoning.encrypted_content"]` (no option to
  suppress it), and Meta returns an `encrypted_content` blob (~1.4 KB) on the reasoning item. It is
  opaque, harmless, and ends up in fixtures.
- **Meta's accepted values** (from its own 400 messages, free to probe):
  - `none` → `reasoning_effort 'none' is not supported for model 'muse-spark-1.3'. Supported
values: [minimal, low, medium, high, xhigh, max]`
  - an unknown value → ``unknown variant `bogus`, expected one of `none`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `max` ``
- The `openai` SDK passes `reasoning: { effort }` and `store` unchanged (its `ReasoningEffort`
  type already includes `minimal`…`max`); its `Response` type lacks `store`, so read it via zod.

**Helper (decision).** `apps/api/src/meta/options.ts`:

- `metaProviderOptions({ reasoningEffort, store? })` → `{ openai: { forceReasoning: true,
reasoningEffort, reasoningSummary: null, store } }` for AI SDK calls.
- `metaResponsesParams({ reasoningEffort, store? })` → `{ reasoning: { effort }, store }` for
  `openai` SDK calls.
- `store` defaults to **`false`** (customer content; nothing reads stored responses back).
- `META_REASONING_EFFORTS` / `metaReasoningEffortSchema` (`minimal`…`max`, no `none`) for the
  definition loader (P2-02). The effort itself always comes from the service definition.

### Effort matrix (Spark, AI SDK, `store: false`)

Same prompt as P1-01 ("In one short sentence, explain what a floor plan shows.", 20 input tokens),
`max_output_tokens: 4096`, one sample each (`fixtures/meta/p1-02/spark-effort.json`):

| Effort (echoed)      | Output tok | Reasoning tok | Est. USD | Answer (abridged)                                           |
| -------------------- | ---------- | ------------- | -------- | ----------------------------------------------------------- |
| `minimal`            | 78         | 54            | 0.00036  | "…the layout of rooms in a building viewed from above."     |
| `low`                | 314        | 289           | 0.00136  | "…the layout of a building's rooms as seen from above."     |
| `medium`             | 462        | 439           | 0.00199  | "…the layout of rooms in a building from above."            |
| `high`               | 739        | 708           | 0.00317  | "…the layout of rooms, walls, doors, and windows…"          |
| `xhigh`              | 450        | 423           | 0.00194  | "…the arrangement of rooms and spaces… as seen from above." |
| `max`                | 570        | 550           | 0.00245  | "…a building's layout from above."                          |
| `minimal` (`openai`) | 85         | 61            | 0.00039  | same as AI SDK `minimal`                                    |

- Every value was echoed back in `reasoning.effort` and every response had `store: false`.
- Effort is a **ceiling, not a floor**: above `high` a trivial prompt does not use more reasoning
  (n = 1, and the same request varied 74–153 reasoning tokens between two probes). `minimal` cut
  the cost ~9× versus `high` with an equivalent answer. P1-03 measures effort on a realistic prompt.

### Usage: where reasoning tokens appear

Same place for every call type (text, vision, structured output) and both SDKs:

- Raw body: `usage.output_tokens_details.reasoning_tokens`, **included in** `usage.output_tokens`
  (all nine recordings: `output = text + reasoning`, `total = input + output`).
- AI SDK: `usage.outputTokens` (total), `usage.outputTokenDetails.reasoningTokens` and
  `textTokens = output − reasoning`. Caveat: `@ai-sdk/openai` maps a missing `reasoning_tokens` to
  `0`, so on the AI SDK path "not reported" and "zero" are indistinguishable (the `openai` SDK path
  keeps `undefined`).
- The raw body is only on `result.response.body` with `include: { responseBody: true }` (AI SDK 7
  drops it by default); the tests use that to assert what Meta echoes.

### Vision (single image)

- AI SDK 7 deprecates the `image` part; use a file part: `{ type: 'file', mediaType: 'image/png',
data: { type: 'data', data: Uint8Array } }`. It is serialized as `input_image` with a
  `data:image/png;base64,…` URL (no `detail` unless `providerOptions.openai.imageDetail` is set).
- Input: `fixtures/meta/p1-02/synthetic-floor-plan.png` (640×480, 2.2 KB), drawn with ffmpeg
  `drawbox` filters: two rooms joined by a door gap, three blue window markers, one red rectangle.
  No text (this ffmpeg build has no `drawtext`), people, or third-party content.
- At effort `low`: **452 input tokens** (the text prompt is roughly 60–70 of them; the rest is the image), 237 output (217 reasoning),
  $0.00157. Answer `rooms=2; windows=3; red=1` — correct; the test asserts the exact counts.
- The fixture matches on the request-body hash, which includes the base64 image: changing the PNG
  invalidates the fixture.
- Real-photo behaviour (interior photos, counts of windows/doors/radiators) is checked in P1-05 and
  P1-06.

### Structured output

- AI SDK 7 deprecates `generateObject`; use `generateText({ output: Output.object({ schema, name })
})`. The result is on `result.output` (validated against the zod schema by the SDK).
- Request mapping: `text.format = { type: 'json_schema', name, strict: true, schema }`. `strict`
  comes from `strictJsonSchema` (default `true`). The SDK's zod → JSON Schema conversion adds
  `additionalProperties: false`, lists every property in `required`, maps a union to
  `type: ["number", "string"]` and `.nullable()` to `type: ["string", "null"]`, and includes
  `$schema: draft-07`. Meta accepts all of it and echoes `text.format` with `strict: true`.
- **Meta enforces strict-mode schema rules server-side**: a schema without
  `additionalProperties: false` is rejected with 400 "'additionalProperties' is required to be
  supplied and to be false." Use `.nullable()`, never `.optional()`, in output schemas.
- Schema shaped like fact extraction: `{ facts: [{ key, value: number | string, unit: string |
null, basis: 'stated' | 'opinion', source }] }`, synthetic notes as input, a `system` prompt,
  effort `low`. 280 input, 1,086 output (765 reasoning), $0.00497. The output parsed and validated;
  8 facts, every `source` a verbatim substring, the seller's belief tagged `opinion`.
- **Finding for the claim validator (P3):** Spark normalised "two bedrooms" to `value: 2`, so a
  digits-only "number appears in source" check fails on spelled-out numbers. The validator must
  handle number words (or the extraction prompt must require the literal form).
- Meta returns the JSON object keys in alphabetical order, not schema order (no effect on parsing).

### Live calls and cost (P1-02)

| Call                                                    | Input tok | Output tok (reasoning) | Est. USD     |
| ------------------------------------------------------- | --------- | ---------------------- | ------------ |
| Probe: effort `none` (400) and unknown effort (400)     | –         | –                      | 0 (rejected) |
| Probe: AI SDK `low`, `store: false`, default summary    | 15        | 163 (153)              | 0.00071      |
| Probe: AI SDK `low`, `store: false`, `summary` omitted  | 15        | 84 (74)                | 0.00038      |
| Probe: `openai` SDK non-strict schema with strict (400) | –         | –                      | 0 (rejected) |
| Probe: `openai` SDK `developer` role, `minimal`         | 38        | 87 (77)                | 0.00042      |
| Effort matrix: 6 AI SDK calls + 1 `openai` SDK call     | 140       | 2,698 (2,524)          | 0.01164      |
| Vision, effort `low`                                    | 452       | 237 (217)              | 0.00157      |
| Structured output, effort `low`                         | 280       | 1,086 (765)            | 0.00497      |
| **Total (11 billed calls, 3 rejected)**                 | 940       | 4,355 (3,810)          | **0.01968**  |

Probes ran from a scratch script outside the repository (not committed); only the recordings are
fixtures. The recordings took about 21 s (matrix), 2 s (vision), and 4 s (structured).

Record commands (from the repo root):

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api spark-effort
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api spark-vision
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api spark-structured
```

## P1-03 — Wonder 1.0: cost and latency

Status: done (pending review). Recorded 2026-10-28 against the same pinned versions as P1-01
(`ai@7.0.155`, `@ai-sdk/openai@4.0.104`, `openai@7.45.1`). All calls: AI SDK, Responses API,
strict `json_schema` output, `store: false`, `maxRetries: 0` (one attempt per measurement).

### Wonder accepts the same efforts as Spark

Probed with two rejected (free) `openai` SDK requests:

- `none` → `reasoning_effort 'none' is not supported for model 'muse-wonder-1.0'. Supported
values: [minimal, low, medium, high, xhigh, max]`
- `bogus` → the same generic ``unknown variant `bogus`, expected one of `none`, `minimal`, …``
  message as Spark.

`META_REASONING_EFFORTS` / `metaReasoningEffortSchema` therefore hold for both models; Wonder
needs the same `metaProviderOptions()` (`openai` key, `forceReasoning: true`) and echoes the
effort, `store: false`, and `text.format.strict: true`.

### Reconciliation input and prompt

Code in `apps/api/src/pipeline/reconciliation/` (the starting point for P2-09 and the eval):

| File                            | Purpose                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `schema.ts`                     | Input catalog schema (with ID/quote/timestamp invariants) and the strict output schema |
| `prompt.ts`                     | System prompt (12 rules) and the user message (compact JSON catalog)                   |
| `synthetic-nl-apartment.ts`     | Fictional Dutch apartment: input plus `…_EXPECTATIONS` (planted defects)               |
| `score.ts`                      | Deterministic score of an output against the expectations (used here and by the eval)  |
| `reconciliation-models.test.ts` | The model/effort matrix (record/replay, one cassette per call)                         |

- **Evidence IDs, not provenance, go to the model.** The catalog has form fields (`F.living_area`),
  transcript turns (`T03`, with `startMs`/`endMs`), candidate facts (`C05`, each with its turn ID,
  timestamps, and a verbatim quote), photo observations (`P05.R1`), and inventory aggregates
  (`INV1`). The output cites catalog IDs only; code maps them to stored provenance, so the model
  never echoes timestamps or coordinates. The input schema rejects a candidate whose quote is not
  verbatim from its turn or whose timestamps differ from the turn's.
- **Synthetic apartment** (no real address or names; postcode `0000 XX` is invalid by design):
  11 form fields (92 m² NEN 2580 living area, label A, 1996, VvE EUR 185, volume 298 m³,
  `plot_area: null`), 22 Dutch transcript turns (4 min 15 s), 24 candidate facts, 12 photos with
  regions, 3 inventory aggregates. Planted defects:
  - `C05` 95 m² NEN 2580 vs `F.living_area` 92 m² NEN 2580 (same basis, different value: conflict);
  - `C06` "bruto zo'n 104 m², incl. berging en muren", no basis (different measure: not a conflict);
  - `C12` "twee slaapkamers" vs `INV1` three distinct bedrooms in `P05`–`P07` (conflict);
  - `C21` "de mooiste straat van de wijk … wordt alleen maar meer waard" (opinion: never verified);
  - and three agreeing values without a stated basis (`C11` 7 m², `C17` 6 m², `C22` 298 m³) that
    must not be flagged either.
- **Output** (`reconciliationOutputSchema`): `verifiedFacts[]` (`key`, `value: number | string`,
  `unit`, `basis`, `evidenceIds[]`), `conflicts[]` (`key`, `kind`, `sides[]` each with
  `evidenceId`, value, unit, basis, statement), `distinctBasisNotes[]`, `rejected[]` (`reason`:
  `opinion | unsupported | duplicate | out_of_scope`). All fields required, `.nullable()` where
  absent, no `min`/`max` constraints; known IDs, exact numbers, and "conflicted facts are not
  verified" are checked in code (`score.ts`), not by the schema.
- **Prompt size:** 4,318 input tokens on Wonder and 4,796 on Spark for the same request (system
  prompt + 12.6 k-character catalog + the JSON schema). The tokenizers differ by ~11%.

### Measurements (reconciliation, one call each)

`maxOutputTokens` 16,000 (Wonder `high`: 24,000). Cost = input × in-price + output × out-price
(reasoning is inside output). Latency is the AI SDK's `performance.responseTimeMs` measured on the
client: Meta's `created_at` and `completed_at` were equal in every response, so the body gives no
server-side duration.

| Call               | Input tok | Output tok | Reasoning tok | Answer tok | Latency | Est. USD |
| ------------------ | --------- | ---------- | ------------- | ---------- | ------- | -------- |
| Wonder `low`       | 4,318     | 2,924      | 876           | 2,048      | 13.7 s  | 0.0758   |
| Wonder `medium`    | 4,318     | 3,876      | 1,898         | 1,978      | 19.5 s  | 0.0948   |
| Wonder `medium` #2 | 4,318 ¹   | 4,045      | 2,125         | 1,920      | 23.0 s  | 0.0982 ¹ |
| Wonder `high`      | 4,318     | 5,575      | 3,707         | 1,868      | 23.4 s  | 0.1288   |
| Spark `medium`     | 4,796     | 6,828      | 5,524         | 1,304      | 22.1 s  | 0.0350   |
| Spark `high`       | 4,796     | 9,780      | 8,430         | 1,350      | 31.4 s  | 0.0476   |

¹ 4,212 of the 4,318 input tokens were reported as `cached_tokens` (identical prefix sent ~3 min
earlier). Our price table has no cached-input rate, so the estimator bills them at the full input
price: every estimate here is an upper bound for repeated prefixes.

- **Wonder reasons far less than Spark** on the same prompt: 876–3,707 reasoning tokens vs
  5,524–8,430. Reasoning grows roughly 2× per effort step on Wonder (low → medium → high:
  876 → ~2,000 → 3,707). The answer is ~2,000 tokens at every effort, so at `low` the answer, not
  the reasoning, dominates Wonder's cost (input $0.017 + answer $0.041 + reasoning $0.018).
- **Wonder is faster than Spark at comparable quality** (13.7 s at `low` vs 22.1 s for Spark
  `medium`). Spark generates faster (~310 output tok/s vs ~180–240) but writes 2–3× more tokens.
- **Variance:** the two `medium` samples differed by 12% in reasoning tokens and 18% in latency.
- **Spark is 2–3× cheaper per call** ($0.035 at `medium`) despite the longer output.

### Quality against the planted defects

Scored with `scoreReconciliation` (deterministic). All six outputs got the same, clean score:

| Check                                                         | W low | W med | W med #2 | W high | S med | S high |
| ------------------------------------------------------------- | ----- | ----- | -------- | ------ | ----- | ------ |
| Living area 95 vs 92 m² (same basis) reported as a conflict   | yes   | yes   | yes      | yes    | yes   | yes    |
| Bedrooms 2 (transcript) vs 3 (photos) reported as a conflict  | yes   | yes   | yes      | yes    | yes   | yes    |
| Gross 104 m² (different basis) not a conflict                 | yes   | yes   | yes      | yes    | yes   | yes    |
| Agreeing values without basis (`C11`/`C17`/`C22`) not flagged | yes   | yes   | yes      | yes    | yes   | yes    |
| Opinion `C21` not verified, rejected as `opinion`             | yes   | yes   | yes      | yes    | yes   | yes    |
| Conflicted evidence kept out of `verifiedFacts`               | yes   | yes   | yes      | yes    | yes   | yes    |
| Provenance: unknown IDs / numeric mismatches / one-sided      | 0/0/0 | 0/0/0 | 0/0/0    | 0/0/0  | 0/0/0 | 0/0/0  |
| Every candidate accounted for                                 | yes   | yes   | yes      | yes    | yes   | yes    |
| Expected verified evidence covered                            | 16/16 | 16/16 | 16/16    | 16/16  | 16/16 | 16/16  |
| Extra (false) conflicts                                       | 0     | 0     | 0        | 0      | 0     | 0      |

Differences are in output hygiene only:

- Wonder `medium` #1 put a sentence into the `basis` of the gross-area fact ("gross, including
  external storage area and walls (basis as stated in C06 quote; …)") and used the key
  `gross_area_c06`. Wonder `high` added duplicate facts (`balcony_area` next to `outdoor_area`,
  `external_storage_room` next to `external_storage_area`). Wonder `low` and both Spark runs were
  clean. More effort did not buy better output on this input.
- **Every run verified the 104 m² gross area as a fact with `basis: null`**, under a different key
  each time (`gross_floor_area`, `floor_area`, `gross_area_including_storage_and_walls`, …). It is
  correctly not a conflict, but a free-text key and basis let a later step cite it as living area.
  P2-09 should constrain `basis` to the market profile's bases plus an explicit "other/unspecified"
  value, normalize keys against the profile's fact list, and mark non-standard-basis areas as not
  publishable as living area. (Verification caught exactly this misuse, see below.)
- The set saturates: four planted defects do not separate the efforts or the models. A harder
  seeded-defect set (near-duplicate keys, unit mismatches, a conflict between two transcript
  turns, a photo that contradicts the form) belongs in the eval (`npm run eval`) before these
  defaults are revisited.

### Verification sizing (one call)

`apps/api/src/pipeline/verification/`: Verified Fact Sheet after Gate 1 (23 facts), 5 NL market
rules, 26 copy segments (14 portal, 4 social, 8 Q&A) that all pass the code-level validator.
Six planted defects need semantic judgment: a gross area sold as "living space" (`S03`), an
invented feature (`S05`, underfloor heating), a superlative (`S08`), an investment promise
(`S12`), exclusionary phrasing (`S17`), and an added servicing claim (`S24`).

| Call                      | Input tok | Output tok | Reasoning tok | Latency | Est. USD |
| ------------------------- | --------- | ---------- | ------------- | ------- | -------- |
| Wonder `low`, claim audit | 1,992     | 2,119      | 1,269         | 12.5 s  | 0.0503   |

- All six planted defects were caught with usable rewrites, and no clean segment was flagged
  except `S06` ("From the kitchen you step onto a 7 m² … balcony"). The fact sheet has no
  kitchen-access fact, so that flag is correct: an unplanted defect in the fixture, kept as is.
- Categories were coarse: superlative, investment promise, and exclusionary phrasing all came
  back as `market_rule`. P3-06 should have the verifier return the violated rule ID.
- Finding for the claim validator (P3-02): copy naturally contains "NEN 2580"; the exact-number
  check must not treat a basis name as a number claim.

### Decision: per-step model and effort defaults

Written into [architecture.md](./architecture.md) §5, §7, and §10.

| Step                      | Model  | Effort   | Fallback       | `max_output_tokens` | Est. USD per run          | Basis                     |
| ------------------------- | ------ | -------- | -------------- | ------------------- | ------------------------- | ------------------------- |
| Fact extraction           | Spark  | `low`    | –              | 8,000               | ~0.02                     | P1-02 `low`, extrapolated |
| Vision inventory (class.) | Spark  | `low`    | –              | 4,000 per photo     | ~0.03–0.06 (10–20 photos) | P1-02 `low`, extrapolated |
| Reconciliation            | Wonder | `low`    | Spark `medium` | 12,000              | 0.076 (fallback 0.035)    | measured                  |
| Creative copy             | Spark  | `medium` | –              | 16,000              | ~0.03                     | extrapolated              |
| Buyer Q&A                 | Spark  | `low`    | –              | 8,000               | ~0.01                     | extrapolated              |
| Verification (per pass)   | Wonder | `low`    | Spark `medium` | 12,000              | 0.05; ≤ 0.15 with 2 loops | measured                  |

Rationale:

- **Reconciliation: Wonder `low`.** It scored clean, it is the fastest configuration measured
  (13.7 s), and its output was the cleanest Wonder output. `medium` (+25% cost, +6–9 s) and `high`
  (+70%) bought nothing on this input. Spark `medium` matched it at 46% of the cost but took 60%
  longer with 6× the reasoning; it is the fallback (labeled as such, §9), and switching the
  primary to it is a definition change if the budget tightens.
- **Verification: Wonder `low`.** One call caught all planted defects at $0.05. Verification is
  the only step that can run three times (two revision loops), so its effort sets the worst case.
- **Spark steps:** extraction, classification, and Q&A are constrained transformations where
  P1-02 showed `low` is accurate; creative copy gets `medium` because copy that fails the
  validator or verifier costs a revision loop (~$0.08), more than the extra reasoning. P3-01
  confirms or lowers it using the validator pass rate.
- **`max_output_tokens` per step** caps a runaway reasoning call at about 4× the measured output
  (worst case reconciliation 8 k × $4 + 12 k × $20 per 1M = $0.27; it never fires at the measured
  ~3–4 k). It is a proposed service-definition field for P2-02.

Per-run estimate for the language-model steps: **~$0.22–0.25** in a typical run (one
verification pass, 10–20 photos), **~$0.44** worst case (30 photos, two full revision loops
re-running creative and verification). With the non-LM steps from §10 ($0.09–0.24) a typical run
is ~$0.31–0.49, under the $0.50 cap, but a worst-case run can exceed it and would then stop at the
cap. To keep loops cheap, P3-06 should re-verify and regenerate only the revised segments (about
$0.01–0.02 per loop instead of $0.08).

### Live calls and cost (P1-03)

| #   | Call                                        | Input tok | Output tok (reasoning) | Latency | Est. USD         |
| --- | ------------------------------------------- | --------- | ---------------------- | ------- | ---------------- |
| 1–2 | Probes: Wonder effort `none`, `bogus` (400) | –         | –                      | –       | 0 (rejected)     |
| 3   | Wonder `low`, reconciliation                | 4,318     | 2,924 (876)            | 13.7 s  | 0.0758           |
| 4   | Wonder `medium`, reconciliation             | 4,318     | 3,876 (1,898)          | 19.5 s  | 0.0948           |
| 5   | Spark `medium`, reconciliation              | 4,796     | 6,828 (5,524)          | 22.1 s  | 0.0350           |
| 6   | Spark `high`, reconciliation (failed)       | –         | –                      | ~36 s   | unknown, ≤ 0.078 |
| 7   | Spark `high`, reconciliation (retry)        | 4,796     | 9,780 (8,430)          | 31.4 s  | 0.0476           |
| 8   | Wonder `high`, reconciliation               | 4,318     | 5,575 (3,707)          | 23.4 s  | 0.1288           |
| 9   | Wonder `medium` #2, reconciliation          | 4,318     | 4,045 (2,125)          | 23.0 s  | 0.0982           |
| 10  | Wonder `low`, verification                  | 1,992     | 2,119 (1,269)          | 12.5 s  | 0.0503           |
|     | **Total (7 recorded calls)**                | 28,856    | 35,147 (23,829)        |         | **0.5304**       |

Call 6 was cut off mid-response (`TypeError: terminated`, TLS `ASN1_get_object:too long` from
undici) about 36 s in. No usage came back and nothing was recorded; whether it was billed is
unknown, so the worst case for the session is $0.608 (its `maxOutputTokens` bound).

Fixtures: `fixtures/meta/p1-03/{wonder-low,wonder-medium,wonder-medium-2,wonder-high,spark-medium,
spark-high,wonder-verification-low}.json`, one cassette per call. Record one call at a time (from
the repo root):

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api reconciliation-models -t "wonder low"
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api verification-model
```

Record mode logs each call's usage and score (pino, `p1-03-measurement`); latency is not stored
in cassettes. The replay tests assert schema validity, echoed settings, and captured usage, never
one recording's quality. Changing either prompt, the synthetic inputs, or the schemas changes the
request hash and requires re-recording.

## P1-04 — Voice Transcribe

Status: done (pending review). Recorded 2026-10-28 against `openai@7.45.1`, `msw@3.0.3`, ffmpeg
9.0.2 (macOS, Homebrew). Sources: Meta API reference (Voice: _Transcribe a recording_, _Schemas_)
and the cookbook recipe `06_muse_voice/01_voice_api_fundamentals` (`utils.py`).

### Code

| File                            | Purpose                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `media/convert.ts`              | `convertToTranscriptionWav(input, output, { sampleRate?, timeoutMs?, maxDurationMs?, signal? })` (ffmpeg) |
| `media/wav.ts`                  | WAV header parser, `assertTranscriptionWav`, `encodePcm16Wav` (silent WAVs for replay)                    |
| `meta/transcribe.ts`            | `transcribeAudio(deps, request)`, `parseTranscribeResponse`, typed `TranscriptTurn`                       |
| `meta/voice-transcribe.test.ts` | Record/replay test, cassette `fixtures/meta/p1-04/voice-transcribe.json`                                  |

`transcribeAudio({ openai, usage, estimateCost? }, { model, mode, audio, fileName?, keywords?,
languageBias?, sessionId?, timeoutMs?, signal? })` returns `{ sessionId, text, audioDurationMs,
turns: TranscriptTurn[] }` with `TranscriptTurn = { index, speaker?, text, startMs, endMs }`.
`model` and `mode` are required arguments: they come from the service definition (P2-02), not
from code. It takes the dependencies explicitly instead of a `MetaClients` method so that
`clients.ts` stayed untouched apart from the guard below; callers pass `clients.openai` and the
same recorder/estimator they gave `createMetaClients`.

### Request (verified live)

`POST /v1/asr/transcribe`, `multipart/form-data` with two parts:

- `request`: a **JSON file part** (`Content-Type: application/json`) holding the settings, not
  form fields: `{ "model", "audioEncoding": "WAV", "mode", "keywords"?, "languageBias"? }`.
  `languageBias` takes language **names** (`["Dutch"]`), `keywords` free strings. Both are
  omitted when empty: the server ignores unknown/empty fields silently, so `[]` would look like a
  working request.
- `audio`: the WAV (`audio/wav`). The filename is not interpreted by the server.
- Optional query `sessionId` (correlation id, echoed back).

**Client: the `openai` SDK's custom request works; native `fetch` is not needed.**
`openai.post<unknown>('/asr/transcribe', { body: formData })` passes a native `FormData` through
verbatim (and re-sends it on retries), and the SDK adds auth, `Accept: application/json`, retries,
and the per-attempt timeout. The audio part is built with `toFile` from `openai/uploads`; the
JSON part is a `Blob`, which undici sends with `filename="blob"` — the server accepts that. The
SDK's own `multipartFormRequestOptions` helper is internal (not in the package `exports`) and
would flatten nested objects into bracketed form fields, so it does not fit this endpoint.

**Standard-mode guard:** because `model` is inside the JSON part, `metaFetch` now also reads a
`request` Blob part of a multipart body (async) and rejects `-contributor` models there;
`transcribeAudio` additionally checks the model before building the request. Both are tested.

Validated before sending (no credit spent on a request the server would refuse): mono 16-bit
integer PCM at 16/24 kHz (header parsed), at most 32 MiB of audio and 10 minutes (600,000 ms).

### Response (verified live)

```json
{
  "sessionId": "voyager/transcribe/3ED93CA563314E029689F354AAE89AFE",
  "transcript": "Goedemiddag, we beginnen met de rondgang door het appartement aan de …",
  "audioDurationMs": 168800,
  "turns": [{ "turnId": 0, "startMs": 0, "endMs": 168300, "transcript": "Goedemiddag, …" }]
}
```

- Exactly the documented `TranscribeResponse` fields. **No `model` and no `usage` field**: the
  billed unit is `audioDurationMs`. The 168.73 s file was reported as 168,800 ms (one sample
  suggests rounding up to 100 ms).
- `turns[].speaker` is present only in `DIARIZATION`; `turns` is empty in `PUSH_TO_TALK`. The zod
  schema requires integer, non-negative `startMs`/`endMs` with `endMs >= startMs`; turns are
  sorted by `turnId` and re-indexed from 0. A malformed response throws
  `TranscriptionResponseError` and records no usage (same rule as P1-01: an unmeasured call fails).

### Usage

`UsageEntry` gained one optional field, `audioDurationMs?: number` (integer ms, taken from the
response, never from the local file). Transcription entries have `sdk: 'openai'`, the request's
`modelId`, `responseId = sessionId`, all token counts `undefined`, and `estimatedCostUsd` from the
`CostEstimator`, which now also receives `audioDurationMs`. The per-second price is applied by the
P2-04 ledger; the test uses an inline $0.18/hour estimator.

### Findings

- **ENDPOINTING returned one turn for the whole 2:49 clip** (0–168,300 ms) in both calls. The TTS
  pauses between paragraphs are too short to end a turn. Real speech pauses more, but this is
  unverified: a single turn makes transcript provenance coarse (one evidence anchor for every
  fact). P2-06/P2-07 should not assume short turns; a follow-up recording with `DIARIZATION`, or
  with real agent audio, must confirm segmentation before P2-07 relies on turn-level anchors.
  **Resolved in P2-06:** `DIARIZATION` on the same audio returned 15 turns of 2–16 s, so intake
  uses it (see [P2-06](#p2-06--intake-step)).
- **Word repetition artifacts.** Both transcripts repeat words that are spoken once: "met in
  totaal 12 12 woningen", "165 euro euro", "zit de zit de". Unbiased: 12 adjacent repeats;
  biased: 5. Numbers can therefore appear twice in a row — fact extraction must not read
  "12 12" as 1212, and the claim validator must cite facts, never raw transcript numbers.
- **Number formatting is mixed:** "zes/zeven vierkante meter" as words, "92/34/14" as digits, and
  "9" vs "negen" for the same phrase across the two calls. Fact extraction must normalize Dutch
  number words.
- **Seeded inconsistency survives transcription.** The script states the NEN 2580 living area as
  "92 vierkante meter" early and "zo'n 95 vierkante meter woonoppervlak" in the summary; both
  calls transcribed both values correctly. Use it in P2-09 (same basis, different value ⇒
  conflict; "zo'n" marks the second as approximate) and in the eval set.
- **Keyword biasing helps, but is a hint.** With the same audio and `languageBias: ["Dutch"]`:

  | Measure (vs. the script, rough word-level WER) | Without keywords           | With keywords              |
  | ---------------------------------------------- | -------------------------- | -------------------------- |
  | WER                                            | 6.5%                       | 5.0%                       |
  | Adjacent repeated words                        | 12                         | 5                          |
  | `VvE`                                          | "VVE" (2×)                 | "VvE" (2×)                 |
  | `meerjarenonderhoudsplan`                      | "meerjaren onderhoudsplan" | correct                    |
  | `HR-ketel`                                     | correct                    | "HRketel" (hyphen dropped) |
  | `Kwartelhoflaan`, `Zandmeer`, `NEN 2580`       | correct                    | correct                    |

  The WER counts digit/word variants ("6" vs "zes") as errors, so it overstates real errors.

- **Latency:** about 33 s per call for 169 s of audio (5.4 MB upload included), ~0.2× real time.
  The default 180 s per-attempt timeout leaves room for ~9 minutes of audio at that rate; pass
  `timeoutMs` for recordings near the 10-minute cap.
- **TTS caveat:** macOS `say` speech is far cleaner than an agent's phone recording (no room
  echo, traffic, or hesitations). Re-check accuracy, repetition, and segmentation on real audio
  when samples arrive.

### Converter (ffmpeg)

`convertToTranscriptionWav` spawns `ffmpeg` with an argument array (`shell: false`), `-nostdin`,
a timeout (default 120 s, `SIGKILL`), and an optional `AbortSignal`; on failure it throws
`MediaConversionError` with the last 8 KB of stderr. Paths are passed as `file:<absolute path>`
so a name can never be read as an option or a `concat:`/network protocol. Output: `-vn
-map_metadata -1 -ac 1 -ar 16000 -c:a pcm_s16le -bitexact -f wav` (metadata dropped, canonical
44-byte header). The written file is then parsed and checked (PCM, mono, 16-bit, requested rate,
non-empty) instead of trusting the exit code.

P2-05 added two options for untrusted uploads: `-protocol_whitelist file` on the input, and
`maxDurationMs` (ffmpeg `-t`), which caps decoding so a long file without a declared duration
(browser-recorded WebM) or with a forged one cannot be converted in full before the 10-minute
check. Upload processing probes with `ffprobe` first (`media/probe.ts`, docs/architecture.md
section 8).

- Verified on the TTS audio: m4a (AAC, 22.05 kHz) and webm (Opus, 48 kHz) both convert to
  16 kHz mono WAVs of the same length (±100 ms); 5.4 MB for 2:49.
- Unit tests generate stereo `lavfi sine` tones (AAC 44.1 kHz, Opus 48 kHz) and cover 16/24 kHz
  output, non-audio input (stderr captured), timeout, and a missing binary.
- **CI has no ffmpeg** (GitHub `ubuntu-24.04` image; the API runtime image installs it). The
  ffmpeg tests skip locally when the binary is missing but **always run when `CI` is set**, so
  the CI job needs `sudo apt-get install -y --no-install-recommends ffmpeg` before the tests.

### Fixture and replay without the audio

The TTS audio is not committed (Apple TTS output redistribution terms are unclear); only the
script is: `fixtures/meta/p1-04/walkthrough-nl.txt` (fictional property, street, and town; no
real names or addresses). Replay must still pass on Linux CI without the audio, so:

- `createMetaReplay({ …, match: { ignoreFileContentFields: ['audio'] } })` matches the `audio`
  part by filename and content type only. All other parts (the JSON settings, including
  keywords) still count. The test fixes the filename `p1-04-walkthrough-nl.wav`, which acts as
  the declared fixture key. Default matching is unchanged (file content hashed).
- In replay mode the test sends a 1-second silent WAV generated in code (`encodePcm16Wav`), so
  neither the audio nor ffmpeg is needed. Record mode converts the local m4a (and checks the webm)
  first.
- Trade-off: a changed audio file under the same name replays the old response silently. That is
  acceptable for a fixed, documented spike input; do not reuse the option where audio content is
  what the test is about.

Regenerate the audio and re-record (macOS; spends credit, about $0.017 for both calls):

```sh
mkdir -p data/p1-04
say -v Xander -f fixtures/meta/p1-04/walkthrough-nl.txt -o data/p1-04/walkthrough-nl.aiff
ffmpeg -i data/p1-04/walkthrough-nl.aiff -c:a aac -b:a 96k data/p1-04/walkthrough-nl.m4a
ffmpeg -i data/p1-04/walkthrough-nl.aiff -c:a libopus -b:a 48k data/p1-04/walkthrough-nl.webm
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api voice-transcribe
```

### Live calls and cost (P1-04)

| Call                                                | Audio (billed) | Latency | Est. cost (USD) |
| --------------------------------------------------- | -------------- | ------- | --------------- |
| ENDPOINTING, `languageBias: ["Dutch"]`, keywords    | 168.8 s        | 33.4 s  | 0.00844         |
| ENDPOINTING, `languageBias: ["Dutch"]`, no keywords | 168.8 s        | 33.4 s  | 0.00844         |
| **Total (2 calls)**                                 | 337.6 s        |         | **0.01688**     |

Estimated at $0.18 per audio hour from `audioDurationMs`; the API returns no cost or usage field.

## P1-05 — SAM 3.1 and output parser

## P1-06 — Muse Image edits

Status: done (pending review). Recorded 2026-10-28 against `ai@7.0.155`, `@ai-sdk/openai@4.0.104`.
Sources: Meta's [image generation guide](https://dev.meta.ai/docs/image-generation), the
[Images API schemas](https://dev.meta.ai/docs/api-reference/images/schemas), the cookbook recipe
`05_muse_image/01_image_api_fundamentals`, and the installed SDK sources.

### Endpoints and client choice

Muse Image is reachable three ways: `POST /v1/images/generations` (text-to-image),
`POST /v1/images/edits` (image-to-image), and the Responses API (`responses.create` with
`model: "muse-image-1.0"`, image returned as an `image_generation_call` output item; the
cookbook's route, multi-turn via `previous_response_id`, `store` defaults to `true`).

**Decision: the AI SDK image API is the client** (`meta/images.ts`). `@ai-sdk/openai`'s
`OpenAIImageModel.doGenerate` posts to `/images/generations` (JSON) for a text prompt and to
`/images/edits` (multipart) as soon as `generateImage({ prompt: { text, images } })` carries input
images. No `openai` SDK fallback was needed. What the SDK sends (proven by the stubbed-fetch
tests in `images.test.ts` and the recorded calls):

- Generation: JSON `{ model, prompt, n: 1, size?, output_format?, response_format: "b64_json" }`.
  The SDK adds `response_format` for every model ID outside OpenAI's `gpt-image-*` and `chatgpt-image-*` families; Meta
  accepts it (`b64_json` is also its default).
- Edit: multipart `model`, `prompt`, `n`, `size?`, `output_format?`, and one `image` part (a Blob
  without a file name, so it goes out as `blob`, with the media type sniffed from the bytes;
  JPEG input worked). Several images would go out as `image[]`. Meta's docs name `image` or
  `image[N]`; multi-image edits are untested.
- `providerOptions` must use the **`openai`** key (same as for Responses models). Only OpenAI's
  options pass: `outputFormat`, `outputCompression`, `quality`, `background`, `user`, and for
  edits `inputFidelity`. Per Meta's docs `mask` and `input_fidelity` return 400; the helper sends neither.
- **Gap:** Meta-specific fields (`reasoning_strength`, default `high`; `tool_enablement`, default
  all on: image search, web search, shell; `temperature`) cannot be sent through the AI SDK image
  model. All P1-06 calls ran with Meta's defaults. If P3-04 wants built-in search off for
  customer photos, or `low` strength for speed, it needs the `openai` SDK (`images.edit` with
  extra fields; how its multipart encoder flattens the nested `tool_enablement` object is
  untested) or the documented JSON edit body (`images: [{ image_url: <data URL> }]`) via
  `openai.post`. Price does not change with either setting.
- `generateImage` has no `timeout` option and no usage callback. The helper bounds the whole call
  (retries included) with `AbortSignal.timeout(timeoutMs)`, matching the AI SDK's own `timeout`
  semantics, measures latency around the call, and records usage via `clients.recordUsage`. Its
  retry layer is the SDK's (`maxRetries` from `aiSdkCallOptions()`); note it also retries a 2xx
  response with zero images (Meta: failed or safety-filtered images are not billed).

### Response shape

From `fixtures/meta/p1-06/edit.json` (the image is stored in `edit.files/`):

```json
{
  "created": 1793154087,
  "data": [{ "b64_json": "<base64 JPEG>" }],
  "output_format": "jpeg",
  "background": "opaque",
  "usage": { "input_tokens": 11867, "output_tokens": 787, "total_tokens": 12654 }
}
```

- No `id`, no `model`, no `size`: the usage entry takes `modelId` from the request and has no
  `responseId`. The helper reads the pixel size from the image header (`imageDimensions`, PNG /
  JPEG / WebP) instead, which also rejects a payload that is not an image.
- `usage` is token counts only. **Billing is flat $0.01 per returned image** (Meta's pricing
  page); the tokens are informational. `UsageEntry.images` carries the billable unit and the
  estimator takes `ImagePrice { usdPerImage }` for image models.
- Every output (WebP and JPEG) carries an XMP packet with IPTC
  `DigitalSourceType = trainedAlgorithmicMedia` (the "AI-generated" marker) and nothing else.
  P2-05's metadata stripping applies to uploads, not to staged outputs; whether the export keeps
  this marker on staged images (it supports the staging disclosure) is a P3-04/P3-07 decision.

### Output dimensions vs input

| Call            | Input               | `size` sent | Output             |
| --------------- | ------------------- | ----------- | ------------------ |
| Generation (6×) | text                | `1536x1024` | 1920×1280 WebP     |
| Edit (5×)       | 1024×682 JPEG (3:2) | `1536x1024` | 1920×1280 JPEG     |
| Edit, hallway   | 1024×682 JPEG (3:2) | none        | **1952×1280** JPEG |

- `size` sets the aspect ratio only; the model renders at its own resolution (here 1.25× the
  requested width and height). Output is never the input size: the 1024×682 edit inputs came back
  at 1.875× their width and height.
- Without `size`, the edit came back at 1952×1280 (aspect 1.525 vs the input's 1.502), so the
  edit pipeline should send `size` derived from the input's aspect ratio, and the integrity check
  must resize (and tolerate a ~1.5% aspect difference) before comparing positions.
- Default output format is `webp`; `output_format: "jpeg"` (via `providerOptions.openai.
outputFormat`) is honored and echoed.

### Edits

Inputs are the downscaled generated samples in `fixtures/samples/synthetic-interiors/` (see its
README for prompts). Each prompt wraps one declared operation: "Edit this photo: `<operation>`.
Change nothing else: keep the camera angle, framing, walls, floor, ceiling, windows, doors,
radiators, and lighting exactly as they are. Do not add people, text, or logos." SSIM/PSNR:
ffmpeg `ssim`/`psnr` filters, output scaled to 1024×682 against the input JPEG.

| Edit (operation)                                   | Out       | Latency | SSIM  | PSNR dB | Visual impression                                                                                                                                                   |
| -------------------------------------------------- | --------- | ------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `living-empty`: add a sofa                         | 1920×1280 | 10.0 s  | 0.771 | 21.0    | Very good. Window, radiator, door, walls, and framing unchanged; sofa placed plausibly.                                                                             |
| `living-dining-cluttered`: declutter the table     | 1920×1280 | 8.4 s   | 0.806 | 20.0    | Clutter fully removed; windows (2), radiators (2), and door kept. But the table itself was redrawn larger and closer to the camera: an unrequested geometry change. |
| `bedroom-empty`: add a bed with linen              | 1920×1280 | 15.4 s  | 0.873 | 22.0    | Good. Door, window, wardrobe kept; the bed stands against the window wall and hides the lower half of the radiator.                                                 |
| `dining-chairs`: replace the dining chairs         | 1920×1280 | 9.1 s   | 0.769 | 18.7    | Good. Six new oak chairs, table, window, door kept; chairs partly occlude the radiator.                                                                             |
| `hallway`: add a runner rug and a plant (no size)  | 1952×1280 | 15.9 s  | 0.900 | 25.6    | Very good. Three doors, radiator, high window, coat rail kept; rug and plant added.                                                                                 |
| `living-empty`: **remove the window** (structural) | 1920×1280 | 9.6 s   | 0.777 | 23.9    | Obeyed despite the "change nothing else" clause: window gone, plain wall, radiator and door kept. A clear structural violation.                                     |

Findings:

- **No pixel preservation, good semantic preservation.** An amplified difference image lights up
  every edge in the frame for every edit: the whole image is re-rendered (floor plank pattern,
  tree texture in the window panes, slight sub-pixel shifts), not composited. Fixed elements kept
  their count and approximate position in all five benign edits.
- **Global similarity cannot be the integrity check.** The structure-altering edit (SSIM 0.777)
  sits inside the benign range (0.769–0.900). This supports the planned object-level check
  (SAM counts + box IoU) for P1-07.
- **Occlusion is legitimate.** Added furniture partly hides radiators in two benign edits; a
  count/IoU check must not treat a partially hidden radiator as removed (P1-07 threshold work).
- **Unrequested object changes happen** (the redrawn table). They are not structural, but the
  staged image is labeled as staged and linked to its original (P3-04), and Gate 2 shows both.
- Latency: edits 8.4–15.9 s (median ~9.8 s), generations 9.3–29.4 s (median ~16 s), all at
  Meta's default `reasoning_strength: high`. Edits reporting ~11–12k input tokens took 8–10 s;
  those reporting ~20k (more internal reasoning or tool use) took 15–16 s.

### Fixture format: external blobs

Muse Image responses carry the image as base64 inside JSON (0.2–0.55 MB per image, about 4.5 MB
for 12 calls). The cassette format (still `formatVersion: 1`) gained an optional `externals` list
on JSON bodies:

```json
"body": {
  "type": "json",
  "value": { "data": [{ "b64_json": "<sha256>.jpg" }], "...": "..." },
  "externals": [{ "pointer": "/data/0/b64_json", "file": "<sha256>.jpg" }]
}
```

- `writeCassette` moves every string of at least 16 KiB that is canonical base64 (re-encoding
  gives the identical string) into `<cassette>.files/<sha256>.<webp|png|jpg|bin>` as decoded
  bytes, so the images are viewable and the JSON stays at ~6 KB. Other strings stay inline.
  Stale blobs from an earlier recording of the same cassette are deleted.
- `readCassette` checks each blob's hash, writes the base64 back at its RFC 6901 pointer, and
  drops `externals`, so replay serves the byte-identical recorded body (verified: replayed images
  equal the live ones). A missing or altered blob fails loudly.
- Cassettes without `externals` (P1-01, P1-02) are unchanged and still load (tested).
- Sizes: `generate.files/` 1.86 MB (6 WebP), `edit.files/` 2.79 MB (6 JPEG, because the edits
  requested `jpeg`; the WebP generations average ~310 KB per image vs ~465 KB for the JPEG
  edits). Each cassette JSON is ~6 KB; `edit.files/` is above the ~2 MB per-cassette target.

### Record

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api muse-image-generate
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api muse-image-edit
```

`P1_06_EXPORT_DIR=<dir>` writes every returned image (and, when recording, a `metrics.jsonl`
with dimensions, latency, and usage) to `<dir>`; it also works in replay. Re-recording the
generations changes the sample set; the edit test reads its inputs from the committed samples,
so the samples must be regenerated before the edits are re-recorded.

### Live calls and cost (P1-06)

| #   | Call                                      | Images | Latency | Input / output tok | Est. USD |
| --- | ----------------------------------------- | ------ | ------- | ------------------ | -------- |
| 1   | Generate `living-empty`                   | 1      | 9.5 s   | 10,394 / 1,068     | 0.01     |
| 2   | Generate `living-dining-cluttered`        | 1      | 16.7 s  | 18,923 / 2,034     | 0.01     |
| 3   | Generate `kitchen-cluttered`              | 1      | 17.7 s  | 19,020 / 2,141     | 0.01     |
| 4   | Generate `bedroom-empty`                  | 1      | 9.3 s   | 10,432 / 1,123     | 0.01     |
| 5   | Generate `hallway`                        | 1      | 15.9 s  | 18,887 / 2,115     | 0.01     |
| 6   | Generate `dining-chairs`                  | 1      | 29.4 s  | 18,556 / 1,844     | 0.01     |
| 7   | Edit `living-empty`: add sofa             | 1      | 10.0 s  | 11,867 / 787       | 0.01     |
| 8   | Edit `living-dining-cluttered`: declutter | 1      | 8.4 s   | 11,606 / 548       | 0.01     |
| 9   | Edit `bedroom-empty`: add bed             | 1      | 15.4 s  | 20,869 / 1,721     | 0.01     |
| 10  | Edit `dining-chairs`: replace chairs      | 1      | 9.1 s   | 11,699 / 640       | 0.01     |
| 11  | Edit `hallway`: rug and plant (no size)   | 1      | 15.9 s  | 20,210 / 1,385     | 0.01     |
| 12  | Edit `living-empty`: remove window        | 1      | 9.6 s   | 11,682 / 606       | 0.01     |
|     | **Total**                                 | **12** |         |                    | **0.12** |

No call failed: each run recorded six successful interactions, and the latencies show no retry
backoff (a failed attempt would not be billed anyway). Budget 0.40 USD; spent
0.12 USD (estimated from the list price; Meta's billing dashboard was not checked).

## P1-07 — Integrity check feasibility

## P2-02 — Model settings in the service definition

Per-step model settings are enforced when definitions load at boot (`packages/shared/src/definitions.ts`, format in [architecture.md §7](./architecture.md#7-definition-formats)), not when a step first calls a model:

- `META_REASONING_EFFORTS` / `metaReasoningEffortSchema` moved to `packages/shared/src/reasoning.ts` so the definition schema can use them; `apps/api/src/meta/options.ts` re-exports the same objects. P1-03 confirmed Wonder accepts the same set as Spark.
- Every language-model step must state `reasoning_effort` and `max_output_tokens`. Spark's API default effort is `high` (P1-02), and reasoning tokens bill at output rates, so neither the effort nor the worst-case output may be left to the API default. The schema caps `max_output_tokens` at 128,000 as a typo guard; that is not a documented API limit.
- A fallback model carries its own `fallback_reasoning_effort` (Wonder at `low` falls back to Spark at `medium` in `listing-launch.v1`).
- Every model ID in a definition must be in `PRICE_TABLE`, and an effort is rejected on a model that is not billed per token (Voice, SAM, Muse Image). `-contributor` IDs are rejected at load time as well as in the fetch wrapper.

## P2-06 — Intake step

Status: done (pending review). Recorded 2026-10-28 against `openai@7.45.1`, `msw@3.0.3`. Code:
`apps/api/src/pipeline/intake/`; design in [architecture.md §5 Intake](./architecture.md#5-run-pipeline).

### Segmentation: `DIARIZATION` vs `ENDPOINTING` (one live call)

Same P1-04 TTS walkthrough (2:49, one synthetic voice), sent exactly as the intake step sends it:
`DIARIZATION`, `languageBias: ["Dutch", "English"]` (from `nl` v1 source languages), and the 25
keywords built from a synthetic fact form (`street_name: Kwartelhoflaan`, `place_name: Zandmeer`,
both fictional) plus `nl` v1 labels and `transcription_keywords`. Cassette:
`fixtures/meta/p2-06/intake-transcribe.json`.

| Measure                 | P1-04 `ENDPOINTING` (keywords) | P2-06 `DIARIZATION`                        |
| ----------------------- | ------------------------------ | ------------------------------------------ |
| Turns                   | 1 (0–168,300 ms)               | **15**, 1.8–15.9 s each (median ~11 s)     |
| Gaps between turns      | —                              | 0–320 ms; first turn starts at 60 ms       |
| Speaker labels          | none                           | `A` on every turn (one TTS voice)          |
| Turn boundaries         | —                              | at sentence ends, 1–4 sentences per turn   |
| `transcript` vs turns   | equal                          | `transcript` = turn texts joined by spaces |
| Adjacent repeated words | 5                              | 10                                         |
| Billed audio            | 168.8 s                        | 168.8 s                                    |
| Latency                 | 33.4 s                         | < 34 s (test wall time)                    |

- **Decision: `DIARIZATION`** (`listing-launch` v1, `transcription_mode`). Its turns are short
  enough to anchor a fact to a sentence or two and to start playback there; `ENDPOINTING` gave one
  anchor for the whole memo. Same price and latency. The speaker label is a bonus (agent vs. a
  seller present at the viewing) that one TTS voice cannot test.
- Response shape unchanged from P1-04 apart from `turns[].speaker`; no new fields.
- Keyword spellings held: `VvE` (2x), `meerjarenonderhoudsplan`, `Kwartelhoflaan`, `Zandmeer`,
  `NEN 2580`, `vlizotrap`, `meterkast`, `opstalverzekering`, `reservefonds`. `HR-ketel` again came
  back as `HRketel` (as in P1-04 with keywords), and "rustige" as "rustigeige". Both seeded
  living-area values (92 and "zo'n 95" m²) survived. Repetitions (10) sit between P1-04's biased
  (5) and unbiased (12) runs; one sample per setting, so this is noise-level, not a trend.
- **Fallback kept as a safety net:** real phone audio may still produce long turns (unverified),
  so turns over `max_turn_seconds` (30 s) are split at sentence ends with timestamps interpolated
  from the character offset and stored as `timing: 'approximate'`. The TTS sample has no turn over
  16 s, so nothing was split. Interpolation assumes a constant speaking rate within the turn; a
  chunk can be off by a few seconds, so playback of approximate turns should start a little early.
- Unverified until real agent recordings exist: segmentation on noisy audio with hesitations,
  speaker separation with two people, and whether `languageBias` with two languages changes
  accuracy compared with `["Dutch"]` alone (this call changed mode, bias, and keywords at once; the
  segmentation difference is far beyond what bias or keywords explain).

### Keyword limits

Meta's Voice schema documents no maximum number or length for `keywords` ("Biasing does not
guarantee an exact spelling"). We cap at 50 terms of up to 64 characters
(`TRANSCRIPTION_KEYWORD_LIMITS` in `packages/shared`): biasing is a hint whose effect thins as the
list grows, and part of the list is user input. `nl` v1 currently yields 23 terms plus the form
values. Raise the cap only with a measurement.

### Replay

`intake-transcribe.test.ts` (`api` project) builds the request through
`buildIntakeTranscribeRequest` and the shared synthetic inputs in `pipeline/intake/testing.ts`; the
integration test replays the same cassette through the real handler and engine. Both match the
`audio` part by filename (`voice-memo.wav`, the fixed name the handler always sends) and type only,
like P1-04, and send a 1-second silent WAV; the `request` JSON part (mode, keywords, language bias)
is matched exactly, so a change to the keyword builder, `nl` v1, or the mode shows up as an
unmatched request. The tests pin the cassette's mode (`DIARIZATION`) instead of reading it from
the definition, so changing the definition's mode does not break replay.

Re-record (macOS, needs the P1-04 TTS audio in `data/p1-04/`, spends ~$0.0085):

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api intake-transcribe
```

### Live calls and cost (P2-06)

| Call                                                     | Audio (billed) | Latency | Est. cost (USD) |
| -------------------------------------------------------- | -------------- | ------- | --------------- |
| DIARIZATION, `languageBias: ["Dutch", "English"]`, 25 kw | 168.8 s        | < 34 s  | 0.00844         |
| **Total (1 call)**                                       | 168.8 s        |         | **0.00844**     |

Budget 0.05 USD. Estimated at $0.00005 per audio second from `audioDurationMs`; the API returns no
cost field, and Meta's billing dashboard was not checked.

## P2-07 — Fact extraction

Status: done (pending review). Recorded 2026-10-28 against `ai@7.0.155`, `@ai-sdk/openai@4.0.104`.
Code: `apps/api/src/pipeline/extraction/`; design in
[architecture.md §5 Fact extraction](./architecture.md#5-run-pipeline).

### Request

- Spark through the AI SDK, `generateText` + `Output.object` (name `fact_extraction`, strict
  `json_schema`), `metaProviderOptions({ reasoningEffort })` (`openai` key, `forceReasoning`,
  `store: false`), effort and `max_output_tokens` from the step. Meta echoed `effort: low`,
  `store: false`, `strict: true`.
- Output schema per market, every field required: `turnIndex` (number; integrality is checked in
  code, strict mode is not relied on for `minimum`/`maximum`), `quote`, `key` (enum of the profile
  keys + `other`), `otherKey` (nullable), `value` (`number | string | boolean`, sent as
  `type: ["number","string","boolean"]`), `unit` and `basis` (nullable enums, sent as `anyOf`),
  `assertion` (`stated | opinion`). Meta accepted the union and the `anyOf` enums.
- Input: system prompt (9 rules) + compact JSON user message with the nl v1 vocabulary (keys,
  labels, types, units, bases, enum values) and the 15 diarized turns (`turnIndex`, `text`; no
  speakers or timestamps). The fact form is deliberately not sent. 2,092 input tokens.

### Measurements (two live calls, same request apart from the cap)

| Call                              | Input tok (cached) | Output tok | Reasoning tok | Answer tok | Result                          | Est. USD |
| --------------------------------- | ------------------ | ---------- | ------------- | ---------- | ------------------------------- | -------- |
| `low`, `max_output_tokens` 8,000  | 2,092 (0)          | 8,000      | 5,468         | 2,532      | `incomplete: max_output_tokens` | 0.0366   |
| `low`, `max_output_tokens` 14,000 | 2,092 (2,033)      | 8,357      | 3,969         | 4,388      | completed, 73 facts             | 0.0381   |

- **8,000 was too small.** The P1-03 estimate (~$0.02, extrapolated from a 280-token toy prompt)
  did not hold: a 3-minute walkthrough yields ~70 facts at ~60 answer tokens each (8 JSON fields
  per fact), and `low` still reasons 4–5.5k tokens on this prompt. The first call was cut off at
  fact 43, which drops the closing turns, exactly where the planted "zo'n 95" sits. The cap is now
  14,000 in `listing-launch` v1 (changed in place before any run existed): ~1.7× the measured 8.4k,
  worst case $0.062 per call. Longer memos (up to 10 min) scale the answer roughly linearly; if
  real memos approach the cap, either raise it or split extraction by turn ranges.
- **Reasoning varies ±30% between identical requests** (5,468 vs 3,969).
- **Prompt caching:** the repeated prefix reported 2,033 of 2,092 input tokens as cached. The
  estimator bills them at full price (no cached rate in the price table), so it is an upper bound.
- Latency: ~25 s for the completed call (test wall time; the cassette stores no timing).
- A truncated answer is unparseable (`NoObjectGeneratedError`, `finishReason: 'length'`). The
  handler maps it to `NonRetryableStepError`: a retry at the same cap would pay for the same
  truncation.

### Quality on the planted items (the recorded call)

| Check                                                          | Result                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Form 92 m² as a candidate                                      | yes: `living_area` 92, `m2`, `NEN2580`, `source = form/living_area`                           |
| Transcript 92 (turn 2, NEN 2580)                               | yes: `living_area` 92, basis `NEN2580`, quote "92 vierkante meter"                            |
| Transcript "zo'n 95" (turn 14, closing summary)                | yes: `living_area` 95, basis `unspecified`, quote "zo'n 95 vierkante meter woonoppervlak"     |
| Both kept separately (no merge, no correction toward the form) | yes                                                                                           |
| Opinions marked                                                | 5: "goed georganiseerd", "rustigeige straat", "gezonde VvE", "licht", "instapklaar"           |
| VvE amount                                                     | `vve_monthly_contribution` 165 `EUR` (turn 12)                                                |
| Spelled-out numbers normalized                                 | correct: drie→3, tweede→2, twaalf→12, zes→6 (storage), zeven→7 (balcony), zes→6 (groups)      |
| Other numbers                                                  | 1987, 2021 (×4), 2019, 2020, 34/14/9 m² (room areas as `other:*_area`, `unspecified`), 10 min |
| Gross/room areas kept off `living_area`                        | yes: storage, balcony, living room, bedrooms all `other:` with `unspecified`                  |
| Quotes verbatim incl. ASR noise ("groepen groepen", "zit zit") | 73/73 passed the quote check; 0 rejected, 0 repaired                                          |

- Only 6 facts used profile keys (`build_year`, `living_area` ×2, `energy_label` ×2,
  `vve_monthly_contribution`); 67 went to `other:`. That is the intended split: reconciliation
  treats `other:` as non-core, and nl v1 has only 8 typed facts.
- Debatable calls, all on the safe side: "je hebt hier de hele middag zon" and "parkeren voor de
  deur" were `stated` (checkable); "een kleine bergzolder" folded into one `attic_access` phrase.
  The address ("Kwartelhoflaan 27 in Zandmeer", fictional) became `other:address`: the copy step
  must decide whether a street may appear in a listing; it is in the candidate set either way.
- Zero repairs and rejections on this recording means the code path is exercised by unit tests,
  not by the fixture. P1-03's free-text-key problem cannot occur by construction (enum + code
  check); whether `basis` is ever claimed without the speaker naming it is untested here (the one
  `NEN2580` was named in the turn).

### Replay and record

`fact-extraction.test.ts` (`api` project) gets the turns by replaying the P2-06 cassette through
the intake request and `toStoredTurns`, then sends the extraction request and asserts structure
(echoed settings, ≥90% of facts survive validation, quotes verbatim, keys and bases within the
vocabulary, valid provenance, and that the candidates parse as a reconciliation catalog with only
IDs assigned). `fact-extraction.integration.test.ts` runs intake → fact extraction through the
engine with both cassettes. `createMetaReplay({ include })` (new) serves earlier cassettes
read-only in both modes, so recording the extraction neither repeats nor re-records the
transcription. The tests pin the step settings the cassette was recorded with
(`walkthroughExtractionStep`). Changing the prompt, schema, vocabulary, or nl v1 facts changes
the request hash and needs a re-record (~$0.04):

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api fact-extraction
```

### Live calls and cost (P2-07)

| #   | Call                                         | Input tok | Output tok (reasoning) | Latency | Est. USD   |
| --- | -------------------------------------------- | --------- | ---------------------- | ------- | ---------- |
| 1   | Spark `low`, cap 8,000 (truncated, not kept) | 2,092     | 8,000 (5,468)          | ~25 s   | 0.0366     |
| 2   | Spark `low`, cap 14,000 (the fixture)        | 2,092     | 8,357 (3,969)          | ~25 s   | 0.0381     |
|     | **Total (2 calls of 3 authorized)**          | 4,184     | 16,357 (9,437)         |         | **0.0747** |

Budget 0.10 USD. Costs from the price table ($1.25 / $4.25 per 1M), cached input billed at the
full rate; Meta's billing dashboard was not checked.
