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

## P1-04 — Voice Transcribe

## P1-05 — SAM 3.1 and output parser

## P1-06 — Muse Image edits

## P1-07 — Integrity check feasibility
