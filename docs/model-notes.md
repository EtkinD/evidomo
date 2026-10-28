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
  ID is therefore `meta.responses`. `@ai-sdk/openai` reads `providerOptions.meta` first and falls
  back to `providerOptions.openai`; P1-02 confirms which reasoning options pass through.
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
  (AI SDK: `providerOptions.meta.store = false`, to be confirmed in P1-02).
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

## P1-03 — Wonder 1.0: cost and latency

## P1-04 — Voice Transcribe

## P1-05 — SAM 3.1 and output parser

## P1-06 — Muse Image edits

## P1-07 — Integrity check feasibility
