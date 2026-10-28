# Model notes

Findings from the Phase 1 model spikes: request/response shapes, API constraints, measured costs,
and the decisions they drive. Each task owns its section; keep the headings stable so spikes can
fill them in parallel. Prices come from [architecture.md §10](./architecture.md#10-cost-controls).

## Summary

Consolidated in P1-08 (2026-10-28) from the task sections below, which hold the evidence. When a
later task overturned an earlier finding, the earlier section says so where it stands. Every cost
is list price × the units the API reported (estimates; Meta's billing dashboard was never
checked), with cached input tokens billed at the full rate. Pinned versions: `ai@7.0.155`,
`@ai-sdk/openai@4.0.104`, `openai@7.45.1`, `@meta-sam/parser@0.1.0`. Base URL
`https://api.meta.ai/v1`, Standard-mode IDs only. The per-run cost estimate lives in
[architecture.md §10](./architecture.md#10-cost-controls).

### Spark 1.3 (`muse-spark-1.3`)

- **Endpoint and client:** `POST /v1/responses` through the AI SDK
  (`generateText({ model: clients.languageModel(id) })`). `openai.responses.create` works too
  and sends the same settings with `metaResponsesParams()`.
- **Request:** `providerOptions: metaProviderOptions({ reasoningEffort })` becomes
  `reasoning: { effort }`, `store: false`, and no reasoning summary. Structured output uses
  `Output.object({ schema, name })`, sent as strict `text.format: json_schema`. Images go as
  `file` parts, sent as `input_image` data URLs.
- **Response:** `output[]` holds a `reasoning` item (empty `summary`) and a `message` with
  `output_text`. `usage` has `input_tokens`, `input_tokens_details.cached_tokens`,
  `output_tokens` (reasoning included), and `output_tokens_details.reasoning_tokens`. JSON keys
  come back in alphabetical order.
- **Efforts:** `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `none` and unknown values get
  a free 400. **The API default is `high`**: 95% of a one-sentence answer was reasoning.
- **Measured:**

  | Call                                                           | Cost                         | Latency |
  | -------------------------------------------------------------- | ---------------------------- | ------- |
  | Trivial prompt, `minimal` / `high`                             | $0.00036 / $0.0032           | –       |
  | Fact extraction, `low`: 2.1k in, 8.4k out (4.0k reasoning)     | $0.038                       | ~25 s   |
  | Photo classification, `low`, per photo: 2.0k in, 0.7–1.1k out  | $0.0056–0.0073, mean $0.0064 | ~4 s    |
  | Reconciliation fallback, `medium`: 4.8k in, 6.8k out           | $0.035                       | 22 s    |
  | Creative copy, `medium`: 4.7k in, 5.8–7.1k out (88% reasoning) | $0.031–0.036                 | ~30 s   |

  A 1024×682 image costs about 870 input tokens, and a 2048×1364 image about 3,600.

- **Decision:** `low` for extraction (cap 14,000), classification (cap 4,000 per photo, on a
  1024-px copy), and Q&A. `medium` for creative copy and as the fallback for both judgment steps.
- **Details:** [P1-01](#p1-01--meta-client-module),
  [P1-02](#p1-02--spark-13-text-vision-structured-output),
  [P1-03](#p1-03--wonder-10-cost-and-latency), [P2-07](#p2-07--fact-extraction),
  [P2-08](#p2-08--vision-inventory), [P3-01](#p3-01--creative-copy).

### Wonder 1.0 (`muse-wonder-1.0`)

- **Endpoint, client, request, and response:** the same as Spark, including the efforts (`none`
  is rejected) and `metaProviderOptions()`. Its tokenizer counts about 11% fewer input tokens
  than Spark's on the same prompt.
- **Measured** on a reconciliation input of 4.3k tokens (24 candidates, 12 photos):

  | Effort   | Cost         | Reasoning tokens | Latency |
  | -------- | ------------ | ---------------- | ------- |
  | `low`    | $0.076       | 0.9k             | 13.7 s  |
  | `medium` | $0.095–0.098 | ~2k              | 20–23 s |
  | `high`   | $0.129       | 3.7k             | 23 s    |

  The ~2k-token answer, not the reasoning, dominates the cost at `low`. Verification at `low`
  (2k in, 26 segments) cost $0.050 and took 12.5 s.

- **Quality:** every effort, and Spark too, caught all four planted defects. More effort bought
  only messier output (sentences in `basis`, duplicate keys).
- **Decision:** `low` for reconciliation and verification (cap 12,000), with Spark `medium` as
  the fallback.
- **Open:** the input was smaller than a real catalog. P2-07 alone yields ~70 transcript
  candidates where the spike had 24, so the per-call cost at production size is not measured
  yet (P2-09). Scaling the input to ~8.5k tokens and the output to ~5k (a ~4k answer, one
  verified entry per candidate, plus ~1k reasoning) gives about $0.13 per call (extrapolated; architecture §10 uses it as the worst case).
- **Details:** [P1-03](#p1-03--wonder-10-cost-and-latency).

### Voice Transcribe (`muse-voice-transcribe-1.0`)

- **Endpoint and client:** `POST /v1/asr/transcribe` through the `openai` SDK's custom request
  (`openai.post`). The AI SDK has no such endpoint.
- **Request:** a multipart body with two parts:
  - `request`: a JSON file part
    `{ model, audioEncoding: "WAV", mode, keywords?, languageBias? }`;
  - `audio`: mono 16-bit PCM WAV at 16 or 24 kHz, at most 32 MiB and 10 minutes.
- **Response:** `{ sessionId, transcript, audioDurationMs, turns[{ turnId, startMs, endMs,
transcript, speaker? }] }`. There is no `model` and no `usage`: the billed unit is
  `audioDurationMs`. `turns` is empty in `PUSH_TO_TALK`.
- **Measured:**
  - 168.8 s of audio billed (rounded up to 100 ms): $0.0084, ~33 s latency (~0.2× real time);
  - `ENDPOINTING` returned 1 turn for the whole clip, `DIARIZATION` 15 turns of 2–16 s;
  - ASR repeats words ("12 12", "euro euro");
  - keyword biasing cut the WER from 6.5% to 5.0% and fixed `VvE`, but `HR-ketel` came back as
    `HRketel`.
- **Decision:** `DIARIZATION`, with `languageBias` from the market profile and keywords from the
  form and the profile (cap 50). Turns over 30 s are split, with approximate timestamps.
- **Details:** [P1-04](#p1-04--voice-transcribe), [P2-06](#p2-06--intake-step).

### Muse Image (`muse-image-1.0`)

- **Endpoints:**
  - `POST /v1/images/generations` (JSON);
  - `POST /v1/images/edits`, as multipart (`image`) or as Meta's JSON body
    (`images: [{ image_url }]`);
  - the Responses API also renders images; not used.
- **Client:**
  - AI SDK `generateImage` (`meta/images.ts`) for generations and plain edits.
  - **Staging customer photos must use the `openai` SDK JSON edit body with every tool off**
    (P1-08). The AI SDK cannot send `tool_enablement`, and the multipart form does not validate
    it. Implemented as `editMetaImageToolsOff` (P3-04); `editMetaImage` is for synthetic
    inputs only.
- **Request:** `model`, `prompt`, `n`, `size` (aspect ratio only), `output_format`
  (`webp` by default), `response_format: b64_json`. Meta-only fields:
  - `reasoning_strength`: `low` or `high`, default `high`;
  - `tool_enablement`: image search, web search, and shell, **all on by default**;
  - `temperature`.

  `mask` and `input_fidelity` return 400.

- **Response:** `{ created, data[{ b64_json }], output_format, background, usage{ input_tokens,
output_tokens, total_tokens } }`. There is no `id`, `model`, or `size`, and no field that
  reports tool use.
- **Measured:**
  - flat $0.01 per returned image (the tokens are informational);
  - edits take 8.4–15.9 s, generations 9.3–29.4 s;
  - output is 1920×1280 for `size` 1536x1024, never the input size; without `size` the aspect
    drifts by 1.5%; `size` = the input's own `1024x682` is accepted and also gives 1920×1280
    (0.10% aspect change, P3-04);
  - the whole frame is re-rendered (no pixel preservation);
  - a "remove the window" edit was obeyed;
  - outputs carry an XMP `trainedAlgorithmicMedia` marker.
- **Decision:**
  - staging is GO (scoped, P1-07);
  - send `size` from the input's aspect ratio;
  - P3-04 edits customer photos through the JSON body with
    `tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false }`.
- **Details:** [P1-06](#p1-06--muse-image-edits),
  [P1-08](#p1-08--muse-image-with-tools-disabled), [P3-04](#p3-04--staging-variants).

### SAM 3.1 (`sam-3.1`)

- **Endpoint and client:** `POST /v1/responses`, non-streaming, through the AI SDK. It returns
  the special-token text byte for byte.
- **Request:**
  - one noun phrase and one image per call (lists return nothing);
  - `metaProviderOptions({ reasoningEffort: 'minimal' })` (echoed, no effect) plus
    `metadata: { mask_encoding: "one_bit", include_confidence: "true" }` (string values).
- **Response:**
  - `output_text` is one line `<0f>id<|box;x1;y1;x2;y2;w;h;c|><|mask;…|>,…\n`, or `""` when
    nothing matches;
  - boxes are in source pixels, with inclusive `x2`/`y2`;
  - masks are box-local;
  - `usage` reports 0 tokens and `images_processed: 1`.
- **Measured:**
  - $0.0025 per call, empty results included;
  - 0.6–1.7 s per call;
  - window and radiator counts were exact on all 12 synthetic images;
  - `door` also matches cabinet and wardrobe doors;
  - occlusion reshapes boxes (IoU down to 0.52).
- **Decision:**
  - SAM serves privacy phrases on every stored photo, evidence (at most 12 per run), and the
    integrity check;
  - our parser handles the token grammar strictly;
  - mask payloads are decoded only by `@meta-sam/parser`;
  - the integrity check compares boxes, not masks or SSIM.
- **Open:** positive privacy recall (faces, plates) is unverified.
- **Details:** [P1-05](#p1-05--sam-31-and-output-parser),
  [P1-07](#p1-07--integrity-check-feasibility), [P2-08](#p2-08--vision-inventory).

### Cross-cutting gotchas

- **The options key is `providerOptions.openai`, never `meta`.** `@ai-sdk/openai` drops other
  keys silently, whatever the provider's `name`. This holds for Responses and image models
  ([P1-02](#reasoning-effort-and-store-through-the-ai-sdk)).
- **Effort needs `forceReasoning: true`.** Without it, the AI SDK drops `reasoningEffort` for
  non-OpenAI IDs with only a warning. `forceReasoning` also:
  - sends `system` as `developer`;
  - strips `temperature`/`topP`;
  - adds `reasoning.summary` unless it is `null`.

  The helper `metaProviderOptions()` sets all of this.

- **`store` defaults to `true` on the server.** Send `store: false` (the helper's default). The
  AI SDK then adds `include: ["reasoning.encrypted_content"]`, an opaque blob that ends up in
  fixtures.
- **No client-side effort check:** any string reaches Meta. `metaReasoningEffortSchema`
  validates definitions at load.
- **Strict `json_schema` is enforced server-side.** `additionalProperties: false` is required,
  and so is every property. Use `.nullable()`, never `.optional()`. Bounds like `min`/`max` are
  checked in code, not trusted to strict mode. Unions and `anyOf` enums are accepted.
- **Reasoning tokens are inside `output_tokens`.** Cost is input × in-price + output × out-price;
  never add reasoning again. The AI SDK maps a missing `reasoning_tokens` to `0`.
- **Reasoning varies ±30% between identical requests** (extraction: 5.5k vs 4.0k), and effort is
  a ceiling. Size `max_output_tokens` from the answer length plus that variance: 8,000 truncated
  extraction.
- **Cached tokens are reported, not discounted** (`cached_tokens`, up to 97% of a repeated
  prefix). No cached rate is documented, so every estimate is an upper bound for repeated
  prefixes.
- **`onLanguageModelCallEnd` errors are swallowed by the AI SDK.** That is why
  `UsageRecorder.record` is synchronous and the ledger flushes after the call.
- **Non-token units:**
  - Voice is billed by `audioDurationMs`;
  - SAM by `usage.images_processed`, read through the AI SDK's `usage.raw`; its tokens are 0;
  - Muse Image by the number of returned images; its tokens are informational.

  A missing unit fails the call. It is never recorded as $0.

- **SAM output is special-token text.** Our parser rejects every grammar deviation. Of the mask
  payload, the docs specify only the marker and base85; the codec is Meta's.
- **The `@meta-sam/parser` mask-marker quirk:** its type comment says `payload` excludes the
  `!`/`~` marker, but `decodeMaskToRaster` requires the marker, so we keep it
  ([P1-05](#mask-decoding-meta-samparser-decision)).
- **Muse Image `tool_enablement` defaults to all tools on** (image search, web search, shell).
  - It is reachable only through the JSON edit body, which validates it strictly.
  - The multipart form accepted a non-boolean value and billed the edit.
  - Meta documents nothing about what the tools do with input images.

  ([P1-08](#p1-08--muse-image-with-tools-disabled))

- **Muse Image does no pixel preservation and has no mask.** Output dimensions are the model's
  own. `generateImage` has no `timeout` and no usage hook (the helper adds both), and it retries a
  2xx response that carries zero images.
- **The `openai` SDK captures `fetch` at construction.** `metaFetch` binds late so that MSW sees
  every request. The standard-mode guard checks JSON bodies and the multipart `request` part.
- **Timestamps:** Meta's `created_at` equals `completed_at`, so latency is client-measured only.
  Cassettes store no timing.

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
- `createTokenPriceEstimator(prices)` is the cost hook used in tests. The real price table
  (`PRICE_TABLE`, `createPriceTableCostEstimator`) and the ledger landed in P2-04
  ([architecture.md §10](./architecture.md#10-cost-controls)).

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
  `reasoning` nor `store` reaches the request). P1-01 had assumed `meta` was read first; its
  text above has been corrected.
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
- Interior-photo behaviour was later checked on the synthetic interiors: SAM counts in P1-05,
  Spark classification and counts in P2-08. Real listing photos remain untested.

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

| Step                      | Model  | Effort   | Fallback       | `max_output_tokens` | Est. USD per run                           | Basis             |
| ------------------------- | ------ | -------- | -------------- | ------------------- | ------------------------------------------ | ----------------- |
| Fact extraction           | Spark  | `low`    | –              | ~~8,000~~ 14,000 ¹  | ~~0.02 est.~~ 0.038 ¹                      | measured in P2-07 |
| Vision inventory (class.) | Spark  | `low`    | –              | 4,000 per photo     | ~~0.03–0.06~~ 0.064–0.128 (10–20 photos) ² | measured in P2-08 |
| Reconciliation            | Wonder | `low`    | Spark `medium` | 12,000              | 0.076 (fallback 0.035)                     | measured          |
| Creative copy             | Spark  | `medium` | –              | 16,000              | ~0.03                                      | extrapolated      |
| Buyer Q&A                 | Spark  | `low`    | –              | 8,000               | ~0.01                                      | extrapolated      |
| Verification (per pass)   | Wonder | `low`    | Spark `medium` | 12,000              | 0.05; ≤ 0.15 with 2 loops                  | measured          |

¹ Superseded by P2-07: 8,000 truncated the answer on a 2:49 walkthrough, so the cap is 14,000;
the measured call cost $0.038 (worst case at the cap: $0.062).

² Superseded by P2-08: $0.0064 per photo for Spark alone, measured; SAM privacy and evidence calls
add $0.005 per photo plus at most $0.03 per run.

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

Per-run estimate, **superseded**: P1-03 estimated ~$0.22–0.25 per typical run for the
language-model steps and ~$0.31–0.49 overall, under the $0.50 cap. Both figures rested on the
extrapolated extraction and classification costs above, which measured about twice as high. The
current estimate is in [architecture.md §10](./architecture.md#10-cost-controls). The
recommendation stands: to keep loops cheap, P3-06 should re-verify and regenerate only the revised
segments (about $0.01–0.02 per loop instead of $0.08).

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

Status: done (pending review). Recorded 2026-10-28 against `ai@7.0.155`, `@ai-sdk/openai@4.0.104`,
ffmpeg 9.0.2. Sources: Meta's [Segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting),
[Read segmentation output](https://dev.meta.ai/docs/sam/reading-segmentation),
[SAM client libraries](https://dev.meta.ai/docs/sam/client-libraries),
[Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits) (SAM section), the
cookbook recipe `07_sam/01_api_basics` (`typescript/sam-api.ts`), and Meta's official
`@meta-sam/parser@0.1.0` (installed; used for mask decoding).

### Code

| File                  | Purpose                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `meta/sam.ts`         | `segmentImage(clients, { modelId, phrase, image, reasoningEffort, includeConfidence? })`                     |
| `meta/sam-output.ts`  | `parseSamImageOutput(text)` → `{ sourceSize, instances }`; `boxIoU(a, b)`                                    |
| `meta/sam-mask.ts`    | `decodeSamMask(mask)`: thin wrapper over `@meta-sam/parser`'s `decodeMaskToRaster` (errors → `SamMaskError`) |
| `meta/sam-overlay.ts` | Inspection only: `renderSamOverlayPng` (RGBA layer via `media/png.ts`, composited by ffmpeg)                 |
| `media/png.ts`        | Minimal RGBA PNG encoder on `node:zlib` (`deflateSync`, `crc32`)                                             |
| `meta/sam-*.test.ts`  | Parser/codec unit tests, stubbed-fetch helper tests, record/replay (`sam-integrity`, `sam-privacy`)          |

`media/convert.ts` now exports `runFfmpeg` and `fileUrl` (unchanged behaviour) for the overlay.

### Request (verified live)

`POST /v1/responses`, **non-streaming**, through the AI SDK: `generateText({ model:
clients.languageModel('sam-3.1'), messages: [{ role: 'user', content: [{ type: 'text', text:
phrase }, { type: 'file', mediaType: 'image/jpeg', data }] }], providerOptions })`. The SDK
serializes it as `input: [{ role: "user", content: [{ type: "input_text" }, { type:
"input_image", image_url: "data:image/jpeg;base64,…" }] }]`.

- **Client: AI SDK; no `openai` fallback needed.** The AI SDK returns the special-token text
  byte-for-byte: the replay test asserts `result.text` equals the recorded `output_text` for all
  36 responses. Meta's docs and the cookbook stream (`stream: true`), but the docs state a
  non-streaming request returns the same result in the same format; for a single image there is
  nothing to render progressively, so the helper does not stream.
- `providerOptions.openai` = `metaProviderOptions({ reasoningEffort })` plus `metadata:
{ mask_encoding: "one_bit", include_confidence: "true" }` (metadata values are strings).
- **Effort: accepted and echoed** (`reasoning: { effort: "minimal" }`), no documented or
  observed effect; tokens stay 0. The helper takes it from the caller like every Responses call;
  `minimal` is the natural definition value. The `include: ["reasoning.encrypted_content"]` the
  SDK adds with `store: false` is accepted and ignored (no reasoning item comes back).
- **`store: false`** is echoed.
- **One noun phrase per request.** Per the docs, commas/semicolons/plus lists return zero matches
  and `and`/newlines segment only one concept; text starting with `<0f>` is parsed as box/point
  prompts. `assertSamPhrase` rejects empty phrases, phrases over 80 characters, and any of
  `\n \r , ; + < > |` before a call is made.
- The helper also rejects a response whose `w`/`h` differ from the image header size (EXIF
  rotation not applied, wrong file). Boxes are always in the pixels of the image as sent.

### Response (verified live)

```json
{
  "id": "resp_…",
  "object": "response",
  "status": "completed",
  "model": "sam-3.1",
  "store": false,
  "reasoning": { "effort": "minimal" },
  "metadata": { "mask_encoding": "one_bit", "include_confidence": "true" },
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [{ "type": "output_text", "text": "<0f>0<|box;…|><|mask;…|>,1<|box;…|>…\n" }]
    }
  ],
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0,
    "output_tokens_details": { "reasoning_tokens": 0 },
    "images_processed": 1
  }
}
```

- **Billing unit is in the response: `usage.images_processed` (1 per call)**, matching the
  pricing page ($2.50 per 1,000 images, streaming or not). Token counts are reported as 0
  (informational). `UsageEntry.images` is taken from `images_processed` (via the AI SDK's
  `usage.raw`), never assumed. If it is missing, the entry is recorded with `images: undefined`
  (the P2-04 ledger then raises `UnpricedUsageError`) and the call throws `SamResponseError`.
  The AI SDK `onLanguageModelCallEnd` hook is not passed for SAM, so no zero-token entry is
  recorded twice.
- Usage is recorded **before** the output is parsed: a malformed output still counts against
  the budget.
- **Zero matches:** `output_text` is `""` (one message item, `status: completed`), still billed.
- Every non-empty output is one line ending in `\n`. Response bodies are 0.9–2.7 KB with
  `one_bit` masks; no fixture `externals` were needed.

### Special-token grammar and parser

`parseSamImageOutput` implements the documented image grammar
(`<0f>id<|box;x1;y1;x2;y2;w;h[;c]|><|mask;x=0;y=0[;c];data=H,W,<enc><base85>|>` records joined
by `,`) and returns:

```ts
interface SamInstance {
  objectId: number; // per-response id; sparse, not a class
  score: number | undefined; // `c`, 0..1, only with include_confidence
  box: { x0; y0; x1; y1 }; // source-image PIXELS, origin top-left, HALF-OPEN
  mask: { encoding: 'one_bit' | 'lossless'; width; height; payload };
}
```

- **Coordinates:** pixels of the image as sent, not normalized. The wire's `x2`/`y2` are
  inclusive (Meta's prompt docs and parser), so `x1 = x2 + 1`. Masks are **box-local** rasters:
  `H × W` equals the box's inclusive height × width in every recorded record (57/57) and every
  doc example, and mask pixel (0, 0) is the box's top-left pixel.
- `segmentImage` adds `label` = the request phrase (SAM segments; it does not classify).
- **Strict, loud rejection** (`SamOutputError`, with the record index): no frame marker, a frame
  other than `<0f>`, more than one line, unknown tokens or fields, repeated fields, missing or
  misplaced `,`, duplicate ids, boxes outside the image or inverted, inconsistent `w`/`h`
  across records, mask origin ≠ `0,0`, raster size ≠ box size, a payload that is empty or not
  printable ASCII free of token delimiters (`| ; , < >`), box/mask confidence mismatch,
  confidence outside 0..1, and any payload the mask decoder rejects. Being stricter than Meta's own parser (which skips unknown fields with a
  warning) is deliberate: a format change should stop the run, not silently change counts.
- Whitespace-only output is the valid empty result.

### Mask decoding: `@meta-sam/parser` (decision)

The docs specify the token, `~` = lossless (default), `!` = one_bit, and "base85, not base64",
but not the payload codec (a context-modelled range coder); they point to Meta's parser.

- **Decision (user, P1-05 review): `@meta-sam/parser@0.1.0` is a dependency of `@evidomo/api`,
  under the SAM License.** It is used only for `decodeMaskToRaster`. Our own code covers the
  special-token grammar, boxes, validation, and the overlay; it contains no codec logic. A
  first, self-written decoder was removed in favour of the official one.
- `decodeSamMask` wraps `decodeMaskToRaster`: `InvalidSegmentationMaskError` becomes
  `SamMaskError` with the original as `cause`. The parser validates strictly (marker,
  base85 shape and length prefix, decoder finalization, and for `one_bit` a canonical
  re-encode), so truncated, corrupted, or wrongly dimensioned payloads are rejected, not
  decoded to noise (`sam-mask.test.ts`, `sam-output.test.ts`).
- **Type comment vs behaviour:** the package's `SegmentationMask.payload` is documented as "the
  text after the encoding marker", but `decodeMaskToRaster` requires the marker (`!`/`~`) at the
  start of `payload`, and its own stream parser passes it that way. A marker-less payload failed
  for all 57 recorded masks, so `SamEncodedMask.payload` keeps the marker and maps 1:1.
- The parser also decodes `lossless` masks, so there is no "unsupported" branch; requests still
  ask for `one_bit` (smaller payloads). No `lossless` payload has been recorded, so that path is
  untested here.
- Before the swap, the self-written decoder and `decodeMaskToRaster` were compared on all 57
  recorded masks: identical rasters (0 mismatches).
- The package's encoder is internal (not exported), so tests build wire records from real
  payloads extracted from `fixtures/meta/p1-05/sam-integrity.json` (`recordedMasks()` in
  `sam-test-support.ts`).

### Measured: counts vs ground truth (P1-07 starting point)

Phrases `window`, `door`, `radiator`, effort `minimal`, confidence on, one recording each
(`fixtures/meta/p1-05/sam-integrity.json`). Ground truth from the samples README. Cells:
SAM count (ground truth).

| Image                                          | Window | Door                       | Radiator | Scores (min–max)                            |
| ---------------------------------------------- | ------ | -------------------------- | -------- | ------------------------------------------- |
| `living-empty`                                 | 1 (1)  | 1 (1)                      | 1 (1)    | 0.85–0.95                                   |
| `living-empty.edit-add-sofa`                   | 1 (1)  | 1 (1)                      | 1 (1)    | 0.85–0.96                                   |
| `living-empty.edit-remove-window`              | 0 (0)  | 1 (1)                      | 1 (1)    | 0.89–0.95                                   |
| `living-dining-cluttered`                      | 2 (2)  | 1 (1)                      | 2 (2)    | 0.81–0.90                                   |
| `living-dining-cluttered.edit-declutter-table` | 2 (2)  | 1 (1)                      | 2 (2)    | 0.85–0.94                                   |
| `kitchen-cluttered`                            | 1 (1)  | **9** (1 open + 1 in hall) | 1 (1)    | window 0.88, radiator 0.94; doors 0.53–0.78 |
| `bedroom-empty`                                | 1 (1)  | **4** (1 + wardrobe doors) | 1 (1)    | doors 0.66–0.86                             |
| `bedroom-empty.edit-add-bed`                   | 1 (1)  | **4** (1 + wardrobe doors) | 1 (1)    | radiator (half hidden by the bed) 0.56      |
| `hallway`                                      | 1 (1)  | 3 (3)                      | 1 (1)    | 0.82–0.88                                   |
| `hallway.edit-add-rug-plant`                   | 1 (1)  | 3 (3)                      | 1 (1)    | 0.73–0.88                                   |
| `dining-chairs`                                | 1 (1)  | 1 (1)                      | 1 (1)    | radiator (behind chairs) 0.68               |
| `dining-chairs.edit-replace-chairs`            | 1 (1)  | 1 (1)                      | 1 (1)    | radiator 0.75                               |

Original vs edit, best-match box IoU per phrase (same 1024-px space; the hallway edit is
1024×672, its `y` scaled by 682/672):

| Edit pair                          | Window     | Door             | Radiator   |
| ---------------------------------- | ---------- | ---------------- | ---------- |
| `living-empty` + add sofa          | 0.96       | 0.97             | 0.94       |
| `living-empty` + **remove window** | **1 → 0**  | 0.98             | 0.94       |
| `living-dining` + declutter        | 0.96, 0.98 | 0.97             | 0.88, 0.92 |
| `bedroom` + add bed                | 0.96       | 0.97 ×3, 0.96    | **0.81**   |
| `hallway` + rug and plant          | 0.91       | 0.95, 0.96, 0.96 | 0.98       |
| `dining-chairs` + replace chairs   | 0.99       | 0.97             | **0.52**   |

Findings:

- **Counts:** windows and radiators match ground truth on all 12 images; the window-removal edit
  is caught by count alone (1 → 0) while door and radiator stay put. Counts are identical for
  every benign pair.
- **`door` also matches cupboard and wardrobe doors** (kitchen 9, bedroom 4), at lower scores
  (0.53–0.66 kitchen cabinets; wardrobe 0.66–0.77) than room doors (0.78–0.92), with no clean threshold between them (wardrobe 0.77 vs the open
  kitchen door 0.78). It is
  consistent between an original and its edit, so the integrity check (compare, not count
  against truth) is unaffected; the README's "1 in hall" kitchen door was not found. A
  `door` count is not usable as a listing fact without Spark.
- **Occlusion shrinks or reshapes boxes:** the radiator hidden behind new chairs dropped to IoU
  0.52 (its box grew to the right, as the mask follows the visible slats), and the one behind
  the bed to 0.81 (score 0.56). Masks cover only the visible part. P1-07 must not use a single
  global IoU threshold blindly; count equality plus a lenient IoU, or IoU only for unoccluded
  classes, looks viable.
- Boxes and masks line up on all 12 overlays inspected (masks follow door panels, window frames,
  and radiator slats; masks stop at occluders such as the table and chairs).
- Latency: privacy calls 0.6–1.7 s; the 36-call run took 22 s at 3 concurrent calls (≈1.8 s per
  image for 3 phrases).

### Privacy phrases (negative cases only)

`person` and `license plate` on `living-empty`, `kitchen-cluttered`, and `hallway`
(`fixtures/meta/p1-05/sam-privacy.json`): 6/6 empty, as expected (no people or vehicles).
**Positive privacy-mask behaviour (faces, bodies, partial people, reflections, plates at
distance) is unverified** until real photos with consent arrive; P2-08 must not assume recall
from these fixtures.

### Overlays

`P1_05_OUT_DIR=data/p1-05 npx vitest run --project api sam-integrity` writes
`data/p1-05/overlays/<image>.png` (window blue, door green, radiator orange; masks at alpha
110/255, boxes 3 px) and `segments.jsonl`, in replay too (no credit). `data/` is gitignored.

### Record

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api sam-integrity
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api sam-privacy
```

SAM output varies slightly between runs (per Meta's docs), so a re-recording may change the
pinned counts in `sam-integrity.test.ts`; that failure is intentional.

### Live calls and cost (P1-05)

| Call                                                       | Calls  | Images billed | Est. USD   |
| ---------------------------------------------------------- | ------ | ------------- | ---------- |
| Probe: AI SDK, `metaProviderOptions` + metadata (`window`) | 1      | 1             | 0.0025     |
| Integrity set: 12 images × `window`/`door`/`radiator`      | 36     | 36            | 0.0900     |
| Privacy negatives: 3 images × `person`/`license plate`     | 6      | 6             | 0.0150     |
| **Total**                                                  | **43** | **43**        | **0.1075** |

Budget 0.40 USD. Estimated from `images_processed` × $0.0025; Meta's billing dashboard was not
checked. No call failed or was retried. The probe ran from a scratch script in the gitignored
`data/p1-05/` folder.

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
  model. All P1-06 calls ran with Meta's defaults. Price does not change with either setting.
  **Resolved in [P1-08](#p1-08--muse-image-with-tools-disabled):**
  - the documented JSON edit body (`images: [{ image_url: <data URL> }]`) sent with
    `openai.post` accepts `tool_enablement` and validates it strictly;
  - `images.edit` sends the field as multipart `tool_enablement[enable_web_search]`, which the
    server does not validate;
  - P3-04 uses the JSON body.
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

Status: done (pending review), 2026-10-28. Offline: no live calls, $0 spent. Input: the recorded
SAM 3.1 output from P1-05 (`fixtures/meta/p1-05/sam-integrity.json`, phrases `window`, `door`,
`radiator`) for the six original/edit pairs in `fixtures/samples/synthetic-interiors/` (five
harmless edits and `living-empty.edit-remove-window`).

### Decision: GO (scoped), with fail-closed fallback per image

Staging stays in scope with the comparison below as the automated gate, and Gate 2 human approval
(original shown next to the staged image) as the backstop. The rule catches removed, added, and
moved fixed elements; the measured structure-altering edit fails on its count whatever the
thresholds. A failed check means one retry, then the original only (architecture §5, step 6), so
a false rejection costs a staged image, never correctness.

**How thin the evidence is:** six synthetic pairs, one image model, one SAM recording each, one
negative (a removal). Muse Image edits are not mask-constrained, so any edit can redraw anything.
No negative tested a moved, resized, or reshaped element; those cases rest on hand-built tests and
geometry, not on observed edits. **What would invalidate the GO** (then switch to FALLBACK,
declutter/object removal only, which is the roadmap cut): on real listing photos (P3-05 or the
seeded-defect eval), (a) SAM counts flicker between an original and a harmless edit often enough
that more than about a third of staged images end up rejected after the retry, or (b) Muse makes
structural changes that keep counts and boxes (a window resized or reshaped in place, a wall
moved) often enough that Gate 2 reviewers find them regularly.

### Rules (`apps/api/src/pipeline/integrity/compare.ts`)

`compareFixedElements(original, edit, { thresholds?, elements? }) → IntegrityVerdict`. Input per
image: `{ width, height, segments: Record<label, { box }[]> }` (`SamSegment[]` from `segmentImage`
fits as is). Pure: no I/O, no model calls; invalid input (bad dimensions or boxes, a compared label
missing on either side, duplicate labels, thresholds out of range) throws `IntegrityInputError`.

1. **Common frame:** boxes are divided by their image's width and height (the unit square), which
   equals resizing both images to one frame. The image fails with `aspect_ratio_changed` when
   `|aspect(edit) / aspect(original) − 1| > maxAspectRatioChange`: after a crop or large stretch,
   positions are not comparable.
2. **Count (primary signal):** any `editCount ≠ originalCount` for a class fails it
   (`count_changed`).
3. **One-to-one matching:** every instance on both sides must be matched
   (`unmatched_original` / `unmatched_edit` otherwise). A pair qualifies when
   - box IoU ≥ `minIoU` (rule `iou`), or
   - for **occlusion-tolerant** classes only: intersection over the smaller box ≥
     `minContainment` **and** smaller/larger box area ≥ `minAreaRatio` (rule `containment`): one
     box lies inside the other and is not a sliver of it.
     Qualifying pairs are assigned greedily by IoU (ties: containment, then index). Greedy can only
     miss a valid assignment, so its failure mode is a false rejection, never a false pass.
4. The verdict passes only with no image failure and no failed class. Per class it reports counts,
   `countDelta`, every match with IoU/containment/area ratio and the accepting rule,
   `worstMatchedIoU`, and unmatched instances with their best IoU against the other side.

| Parameter              | Default                                      | Why                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minIoU`               | 0.75                                         | Benign worst on non-tolerant classes 0.909 (hallway window). Rejects an equal-size box shifted by more than 1/7 (14%) of its width                                                     |
| `minContainment`       | 0.85                                         | Benign containment ≥ 0.962 on every pair; 0.85 rejects an equal-size shift above 15%, consistent with `minIoU`                                                                         |
| `minAreaRatio`         | 0.4                                          | Benign worst 0.52 (dining-chairs radiator, accepted only by containment). Rejects a tolerant element shrunk to under 40% of its box                                                    |
| `maxAspectRatioChange` | 0.03                                         | Measured 1.49% when the edit was sent without `size` (hallway, 1024×672 vs 1024×682); 0% with `size`. 3% is twice the worst seen                                                       |
| `occlusionTolerant`    | window `false`, door `true`, radiator `true` | Windows sit above furniture height and were never occluded (IoU ≥ 0.91). Without the containment path a window resized in place fails on IoU (below 0.75 at less than 75% of the area) |

These are code defaults (`DEFAULT_INTEGRITY_THRESHOLDS`, `DEFAULT_FIXED_ELEMENTS`). They belong in
the `integrity_checker` step of the service definition when P3-05 wires the step (`fixed_elements`
with `occlusion_tolerant`, and the four thresholds), next to `segmentation_model`; that is a
schema change, so it was not made here.

### Measured on the six recorded pairs

All images 1024×682 except the hallway edit (1024×672; aspect change 1.49%, compared in the common
frame). Cells: original → edit count; matched-pair IoU (rule). `c` = containment, `a` = area ratio,
shown where the containment path matters.

| Edit pair                                   | Window                            | Door                              | Radiator                                                   | Verdict                    |
| ------------------------------------------- | --------------------------------- | --------------------------------- | ---------------------------------------------------------- | -------------------------- |
| `living-empty` + add sofa                   | 1 → 1; 0.961                      | 1 → 1; 0.968                      | 1 → 1; 0.937                                               | pass                       |
| `living-dining-cluttered` + declutter table | 2 → 2; 0.957, 0.981               | 1 → 1; 0.968                      | 2 → 2; 0.880, 0.919                                        | pass                       |
| `bedroom-empty` + add bed                   | 1 → 1; 0.965                      | 4 → 4; 0.973, 0.966, 0.969, 0.961 | 1 → 1; 0.810 (iou; c 0.989, a 0.826), bed hides lower half | pass                       |
| `hallway` + rug and plant (no `size`)       | 1 → 1; 0.909                      | 3 → 3; 0.945, 0.963, 0.955        | 1 → 1; 0.983                                               | pass                       |
| `dining-chairs` + replace chairs            | 1 → 1; 0.991                      | 1 → 1; 0.971                      | 1 → 1; **0.516 (containment; c 0.995, a 0.520)**           | pass                       |
| `living-empty` + **remove window**          | **1 → 0**; unmatched (best IoU 0) | 1 → 1; 0.977                      | 1 → 1; 0.937                                               | **fail: `window`** (count) |

5/5 harmless edits pass, the structural edit fails on `window` only. The dining-chairs radiator is
the one pair IoU alone would reject: its box _grew_ (0.52 of the area becomes visible slats
between the new chairs, to the right of and below the old box), and the original box lies inside
it (containment 0.995). Occlusion therefore changes boxes in both directions, which is why the
tolerant rule is symmetric (intersection over the smaller box), not "edit inside original".

### Margin analysis (`recorded-pairs.test.ts`, "sensitivity")

- **Slack per benign matched pair** (22 pairs), measured against the rule that accepts it (for
  tolerant classes the better of the two paths): the minimum is **0.12** (dining-chairs radiator,
  area ratio 0.520 vs 0.4). Next: bedroom radiator 0.139 (containment 0.989 vs 0.85; its IoU path
  has only 0.06), hallway window 0.159 (IoU 0.909 vs 0.75).
- **Where the first benign pair fails** when one threshold is raised (others at default):
  `minIoU` > 0.90 (hallway window), `minContainment` > 0.99 (dining-chairs radiator),
  `minAreaRatio` > 0.51 (same radiator). The defaults sit 0.15, 0.14, and 0.11 below those break
  points.
- **The negative does not constrain the thresholds:** it fails for every setting from 0.05 to 1.0
  because the count changes. The thresholds are set by the benign floor and by geometry, and their
  rejecting power is shown on hand-built and perturbed cases only: shifting a recorded window,
  door, or radiator sideways by 20% of its width fails, by 5% passes; a moved element with
  unchanged count, an element removed while another appears, a radiator reduced to a 31% sliver,
  and a window shrunk to 54% of its area all fail (`compare.test.ts`).

### Alternatives measured and rejected

- **Single global IoU threshold:** the benign range includes 0.516 (occluded radiator). A
  threshold low enough to pass it (≤ 0.5) accepts a box shifted by a third of its width.
- **Mask-based overlap** (masks rasterized into a common 512×512 grid): mask IoU is _lower_ than
  box IoU where visibility changes (declutter radiators 0.67 and 0.73 vs box 0.88 and 0.92;
  bedroom radiator 0.70), and mask intersection-over-smaller (0.954–1.000 on all benign pairs)
  carries the same information as box containment while needing every mask decoded. Boxes only.
- **Global similarity** (SSIM/PSNR) was already ruled out in P1-06 (the structural edit sits
  inside the benign SSIM range).

### Blind spots (what the check cannot see)

- **A window, door, or radiator resized or reshaped in place** within the tolerances: windows down
  to about 75% of the box area, doors and radiators down to 40% (containment path); a window turned
  into a door-height window may still pass if the box grows less than that.
- **Element type changes that keep the box:** a panelled door replaced by a glass door, a window
  replaced by a French door (SAM may still call it `window` and/or `door`), a radiator restyled.
- **Anything that is not a fixed-element class:** walls moved or removed, ceiling height, floor
  material, room proportions, fireplaces, stairs, built-in kitchens, view through the window. Add
  phrases (each costs one SAM call per image) only with measurements.
- **`door` noise:** SAM also counts cabinet and wardrobe doors (kitchen 9, bedroom 4). This is
  consistent between an original and its edit, so it caused no false failure here, but an edit
  that adds furniture with doors (a wardrobe, a sideboard) fails `door` (fail-closed). A real door
  removed while a cabinet door appears keeps the count; matching still rejects it unless the two
  boxes coincide.
- **Lookalikes:** a staged mirror, framed artwork, or a TV can be segmented as `window`, failing an
  otherwise valid edit (fail-closed).
- **Full occlusion:** a fixed element completely hidden by new furniture is indistinguishable
  from a removal and fails (fail-closed; legitimate staging can do this, e.g. a wardrobe in front
  of a radiator).
- **SAM variance:** counts were stable across these pairs from one recording each; Meta documents
  slight run-to-run variation. Low-score instances (cabinet doors at 0.53–0.66) are the most
  likely to flicker. No score filter is applied, because filtering would itself make counts depend
  on scores near a cut-off.

### For P2-08 and P3

- **P3-04 (staging):** send `size` derived from the input's aspect ratio (P1-06), so the aspect
  check sees ~0%. Declared operations that place tall furniture against a window wall, or add
  wardrobes and cabinets, are the likeliest false rejections.
- **P3-05 (integrity step):** segment `window`, `door`, `radiator` on the original **once** and
  reuse it for every variant and retry; each edit then costs 3 SAM calls ($0.0075), not 6. Store
  the whole `IntegrityVerdict` (it is JSON-safe) with the staged-image artifact so Gate 2 can show
  why an image was rejected. Move thresholds and element rules into the definition (above). Re-run
  `recorded-pairs.test.ts` style numbers on the seeded-defect eval; add at least one moved and one
  resized negative there.
- **P2-08 (vision inventory):** nothing required; the comparison is independent of the vision
  step. If vision already segments the original's fixed elements, P3-05 can reuse those results.

### Code and tests

| File                                        | Purpose                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pipeline/integrity/compare.ts`             | `compareFixedElements`, defaults, verdict types, `IntegrityInputError`                                                                                                                                 |
| `pipeline/integrity/compare.test.ts`        | 16 hand-built cases: resolution and aspect changes, moves, occlusion, resizes, counts, empty classes, ordering, invalid input                                                                          |
| `pipeline/integrity/recorded-pairs.test.ts` | 13 cases on the replayed P1-05 output: the six verdicts, the IoU table, margins, threshold sweep, perturbed shifts. Forces `mode: 'replay'`, so `RECORD=1` never rewrites the P1-05 cassette from here |

## P1-08 — Muse Image with tools disabled

Status: done (pending review), 2026-10-28, against `openai@7.45.1`. Sources: Meta's
[Images API schemas](https://dev.meta.ai/docs/api-reference/images/schemas) and the
[image generation guide](https://dev.meta.ai/docs/image-generation).

### Why

Muse Image's built-in tools (image search, web search, and shell) are on unless the request turns
them off. Meta documents nothing about what the tools receive or where a search goes. P3-04 sends
customer photos to edits, so the tools must be off. The AI SDK image model cannot send the field
(P1-06).

### What the docs say

- `tool_enablement` is an `ImageToolEnablement` object with three optional booleans:
  `enable_image_search`, `enable_web_search` (`false` also drops the browser tools), and
  `enable_shell`. "Omit `tool_enablement` to keep every tool available, or set a field to `false`
  to turn that tool off." It is listed on both the multipart edit schema and the JSON edit body.
- The guide says "With the OpenAI SDK, pass them through `extra_body`". The guide's only images
  example uses JSON. "Disabling tools trades some grounding accuracy for speed".
- The `Images Response` has no field that reports tool use. Its `usage` is token counts only.

### Probes and the recording

All three calls used the same synthetic input (`living-empty.jpg`, 1024×682) and a sofa edit with
`maxRetries: 0`:

| #   | Transport                                        | `tool_enablement`                     | Result                                                                                                          | Cost  |
| --- | ------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | JSON body, `openai.post('/images/edits')`        | `enable_web_search: "nope"` (invalid) | **400** in 0.9 s: `` `tool_enablement.enable_web_search`: invalid type: string "nope", expected a boolean ``    | $0    |
| 2   | JSON body, `openai.post` (the fixture)           | all three `false`                     | 200 in 8.5 s, 1920×1280 JPEG, usage 11,769 in / 687 out                                                         | $0.01 |
| 3   | multipart, `openai.images.edit` (`extra` fields) | `enable_web_search: "nope"` (invalid) | **200** in 13.0 s, WebP, usage 11,842 in / 838 out: the invalid value was not rejected, and the edit was billed | $0.01 |

Total: 3 requests, 2 billed images, **$0.02** of the $0.03 authorized.

Findings:

- **The JSON edit body parses `tool_enablement` strictly.** Probe 1 shows that the server
  deserializes the nested object with typed booleans. Probe 2 then sent valid booleans and was
  accepted. That is the strongest evidence the API offers that the setting is applied.
- **The multipart form does not validate it.** The `openai` SDK flattens nested objects into
  bracketed form fields (`tool_enablement[enable_web_search]=nope`), and the server accepted a
  non-boolean there. It either ignores those fields or treats the strings loosely; we cannot tell
  which. `openai.images.edit` therefore cannot be trusted to turn the tools off.
- **No direct proof that the tools stayed idle.** The response carries no tool trace. The
  recorded edit looks like the P1-06 tools-on recording of the same operation:
  - P1-06, multipart, tools on: 11,867 in / 787 out, 10.0 s;
  - P1-08, JSON, tools off: 11,769 in / 687 out, 8.5 s.

  Both sit in P1-06's fast group, so neither call appears to have used a tool. The comparison
  cannot prove anything at n = 1 per arm, and P1-06's slower ~20k-token edits remain
  unexplained.

- The output geometry matches P1-06: `size` 1536x1024 gives 1920×1280, and the response fields
  are the documented `created`, `data`, `output_format`, `background`, and `usage`. Visual check:
  the window, radiator, door, floor, and framing were kept, the sofa was added, and no people
  appeared.

### Request shape for P3-04 (decision)

**Use the `openai` path with every tool off**, as the JSON edit body:

```ts
await clients.openai.post<unknown>('/images/edits', {
  body: {
    model, // from the service definition (creative.image_model)
    prompt, // the declared operation
    images: [{ image_url: `data:image/jpeg;base64,${photo.toString('base64')}` }],
    n: 1,
    size, // derived from the input's aspect ratio (P1-06)
    output_format: 'jpeg',
    response_format: 'b64_json',
    tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
  },
});
```

- Validate the response with zod and read the size from the image header (as `editMetaImage`
  does). Record usage with `clients.recordUsage({ sdk: 'openai', images: data.length, … })`.
  `captureOpenAIUsage` does not fit this endpoint: it requires a `model` field, which the images
  response lacks, so it would throw `UsageCaptureError`. Route the call through
  `ledger.meter` like every model call.
- Retries and the per-attempt timeout come from the `openai` client, so there is no second retry
  layer. Unlike `generateImage`, the `openai` SDK does not retry a 2xx response that carries zero
  images; the caller must treat that case as a failure (unbilled per Meta).
- The base64 image makes the JSON body ~1.37× the photo size. A 2048-px stored photo (P2-05)
  stays well under any limit we know of, but Meta documents no request size limit for this
  endpoint.
- Keep `editMetaImage` (AI SDK) for synthetic inputs only, such as tests and sample generation,
  or remove it for edits when P3-04 adds the JSON helper. **No customer photo may go through
  the AI SDK or the multipart path**, because both leave the tools on (or unverifiably off).
- `reasoning_strength` stays at the default `high`: `low` was not measured, and the price is the
  same either way.

### Fixture and test

`apps/api/src/meta/muse-image-tools-off.test.ts` replays `fixtures/meta/p1-08/muse-image-tools-off.json`.
The image is in `muse-image-tools-off.files/`. The test asserts:

- the response carries only the documented fields, so a new field (such as a tool trace) fails
  on re-recording;
- one 1920×1280 JPEG is returned;
- `output_format` is echoed;
- one usage entry is recorded, with `images: 1` and $0.01.

The request hash includes `tool_enablement`, so a request without it cannot replay this fixture.
The probes ran from a scratch script outside the repository (400 responses are never stored).

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api muse-image-tools-off
```

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

## P2-08 — Vision inventory

Status: done (pending review). Recorded 2026-10-28 against `ai@7.0.155`, `@ai-sdk/openai@4.0.104`.
Code: `apps/api/src/pipeline/vision/`; design in
[architecture.md §5 Vision inventory](./architecture.md#5-run-pipeline).

### Requests

- **Spark, one call per photo:** `generateText` + `Output.object` (name `photo_inventory`, strict
  `json_schema`), `metaProviderOptions({ reasoningEffort })`, effort and `max_output_tokens` from
  the step. System prompt (6 rules + the market's evidence objects + the privacy phrases) is the
  same for every photo of a run; the user message is one fixed sentence plus the image. Meta
  echoed `effort: low`, `store: false`, `strict: true`. Output: `subject` (enum of 23),
  `otherSubject`, `summary`, `quality`, `qualityIssues` (enum array), `coverScore` (number,
  integrality and range checked in code), `observations[]` (`object` enum of the evidence object
  IDs + `other`, `otherObject`, `count`, `detail`), `privacySubjects` (enum of the privacy
  phrases). Meta accepted the nested arrays of enums.
- **SAM:** unchanged `segmentImage` (P1-05) with effort `minimal` (`SAM_REASONING_EFFORT`; the
  definition rejects an effort on SAM, and `minimal` keeps the requests identical to the P1-05
  recordings), privacy phrases on the stored photo, evidence phrases from the market profile.

### Measured: Spark input resolution (probe, `kitchen-cluttered`)

| Image sent                     | Input tok (cached) | Output tok (reasoning) | Est. USD | Latency |
| ------------------------------ | ------------------ | ---------------------- | -------- | ------- |
| 1024×682 sample, as stored     | 2,011 (0)          | 705 (509)              | 0.00551  | 3.9 s   |
| 2048×1364 (sharp upscale, q85) | 4,773 (1,137)      | 1,388 (1,125)          | 0.01187  | 7.5 s   |

- The 1,137 cached tokens equal the shared prefix (system prompt and schema), so a 1024×682
  image is ≈ 870 input tokens and a 2048×1364 image ≈ 3,600 (4×, roughly linear in pixels). The
  bigger image also drew twice the reasoning (n = 1, same answer apart from two extra `other`
  observations).
- **Decision: Spark classifies a copy downscaled to 1024 px on the long edge**
  (`classification_long_edge_px: 1024` in `listing-launch` v1; photos already within it are sent
  byte for byte). Production photos are stored at 2048 px (P2-05), which would have doubled the
  step's Spark cost for no classification benefit. SAM keeps the stored photo: it bills per image
  regardless of size, and small faces or plates need the resolution.

### Measured: the six synthetic originals (the recording)

| Photo                     | Subject     | Quality    | Cover score → rank | Window / radiator (Spark = SAM = truth) | Other observations                         |
| ------------------------- | ----------- | ---------- | ------------------ | --------------------------------------- | ------------------------------------------ |
| `living-empty`            | living_room | good       | 8 → 1              | 1 / 1                                   | wooden_floor, interior_door                |
| `dining-chairs`           | dining_room | good       | 7 → 2              | 1 / 1                                   | wooden_floor, interior_door                |
| `bedroom-empty`           | bedroom     | good       | 6 → 3              | 1 / 1                                   | built_in_wardrobe, carpet_floor            |
| `living-dining-cluttered` | living_room | acceptable | 6 → 4              | 2 / 2                                   | herringbone_wooden_floor, interior_door    |
| `kitchen-cluttered`       | kitchen     | acceptable | 4 → 5              | 1 / 1                                   | kitchen_sink, kitchen_cabinets, countertop |
| `hallway`                 | hallway     | good       | 3 → 6              | 1 / 1                                   | coat_rack, wooden_floor, interior_door ×3  |

- Every photo classified; subjects are right (the living-and-dining scene is called a living
  room, which the tests accept); cover ranks put the empty living room first and the hallway
  last, as the prompt intends. Spark's window and radiator counts match the samples' ground truth
  on all six, and so does SAM's segmentation of them.
- Spark's per-photo answer: 2,011 input tokens (the first calls cached the 1,137-token prefix only
  on half of the concurrent requests), 728–1,137 output tokens of which 507–928 reasoning;
  **$0.0056–0.0073 per photo, mean $0.0064**. That is about twice the ~$0.003/photo the cost table
  extrapolated earlier; reasoning (≈ $0.003) is half of it.
- **Evidence:** the nl v1 objects visible in these empty interiors are only `window` and
  `radiator`, giving 12 candidates for a cap of 12: all 12 requests were selected, and all 12 were
  byte-identical to P1-05 recordings, so they replay from `p1-05/sam-integrity` (no new spend).
  The breadth-first selection, the mask cap, `not_found`, and `not_requested` are therefore
  proven by the stubbed tests (`inventory.test.ts`), not by this recording.
- **Privacy:** both phrases on all six photos: 12/12 empty (6 replayed from `p1-05/sam-privacy`,
  6 new), and Spark listed no privacy subject: every photo is `clear`. **Positive privacy recall
  remains unverified**: there is still no consented photo with a person, a reflection, a framed
  portrait, or a plate. The `review` status (Spark sees a person that SAM misses) is the only
  safety net built for that case, and it is tested only with stubs.

### Cost per run (measured unit costs)

| Photos         | Spark ($0.0064) | SAM privacy ($0.005) | SAM evidence (≤ 12) | Step total |
| -------------- | --------------- | -------------------- | ------------------- | ---------- |
| 10             | $0.064          | $0.050               | ≤ $0.030            | **~$0.14** |
| 20             | $0.128          | $0.100               | ≤ $0.030            | **~$0.26** |
| 30 (input max) | $0.192          | $0.150               | ≤ $0.030            | **~$0.37** |

- Spark's worst case at the 4,000-token cap is $0.0195 per photo (30 photos: $0.59 for Spark
  alone; the run cap stops it first). The measured maximum is 1,137 output tokens.
- Against the $0.50 run cap, vision inventory is now the largest step for runs of 20+ photos.
  Levers, none applied (each needs a definition change and a re-recording): Spark effort
  `minimal` (saves roughly the $0.003 reasoning per photo, quality unmeasured), a lower
  `max_output_tokens` (2,000 still leaves 1.8× headroom and halves the worst case), and scoping
  `license plate` to exterior subjects (saves $0.0025 per interior photo, but weakens the rule
  that every photo is privacy-checked for every phrase).

### Replay and record

`vision-inventory.test.ts` (`api`) runs the inventory core on the six originals with
`createMetaReplay({ include: ['p1-05/sam-privacy', 'p1-05/sam-integrity'] })`, so SAM requests
already recorded in P1-05 are served from there in both modes and never re-sent.
`vision-inventory.integration.test.ts` runs the step through the engine with the samples in
local storage. The tests pin the step settings the cassette was recorded with
(`sampleVisionStep`). Changing the prompt, schema, nl v1 evidence objects, privacy phrases, or
the samples changes the request hashes and needs a re-record (~$0.05):

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api vision-inventory.test
```

The echo assertion (one repeated Spark request) runs in replay only: in record mode the repeat
would be re-sent and overwrite the recording the other assertions saw.

### Live calls and cost (P2-08)

| #   | Call                                                   | Input tok | Output tok (reasoning) | Images | Est. USD   |
| --- | ------------------------------------------------------ | --------- | ---------------------- | ------ | ---------- |
| 1   | Probe: Spark `low`, `kitchen-cluttered` 1024 px        | 2,011     | 705 (509)              | –      | 0.00551    |
| 2   | Probe: Spark `low`, same image upscaled to 2048 px     | 4,773     | 1,388 (1,125)          | –      | 0.01187    |
| 3   | Recording: Spark `low`, 6 photos                       | 12,066    | 5,414 (4,172)          | –      | 0.03809    |
| 4   | Recording: SAM `person` + `license plate`, 3 photos    | 0         | 0                      | 6      | 0.01500    |
|     | Replayed from P1-05 (6 privacy + 12 evidence requests) |           |                        | (18)   | 0          |
|     | **Total (14 billed calls)**                            | 18,850    | 7,507 (5,806)          | 6      | **0.0705** |

Budget 0.15 USD. Costs from the price table ($1.25 / $4.25 per 1M; $0.0025 per SAM image),
cached input billed at the full rate; Meta's billing dashboard was not checked. No call failed
or was retried. The probes ran from a scratch script outside the repository (not committed).

## P2-09 — Reconciliation

Status: done (pending review). Recorded 2026-10-28 against `ai@7.0.155`, `@ai-sdk/openai@4.0.104`.
Code: `apps/api/src/pipeline/reconciliation/`; design in
[architecture.md §5 Reconciliation](./architecture.md#5-run-pipeline).

### Request

- Wonder through the AI SDK, `generateText` + `Output.object` (name `reconciliation`, strict
  `json_schema`), `metaProviderOptions({ reasoningEffort })`, model, effort, and
  `max_output_tokens` from the step (`muse-wonder-1.0`, `low`, 12,000); fallback from the step
  (`muse-spark-1.3`, `medium`). Meta echoed `effort: low`, `store: false`, `strict: true`.
- Input: the step prompt (`step-prompt.ts`, 10 rules) and the compact catalog of the recorded
  P2-07 candidates (7 form fields, 15 turns, 67 stated transcript candidates; the 6 opinions are
  not sent) and the P2-08 photo facts (6 photos, 26 regions with key and per-photo count): 21.2k
  characters of JSON. Market facts are listed with type, unit, and basis and are compared in
  code, so the model only judges `other:` facts, photo support, and cross-key contradictions.
- Output, smaller than P1-03's: `verifiedFacts { key, value, evidenceIds }`,
  `conflicts { key, kind, evidenceIds, explanation }`, `rejected { evidenceId, reason,
explanation }`. No units, bases, or side values are echoed (code reads them from the facts):
  the answer, not reasoning, dominated Wonder's cost at `low` in P1-03.

### Measurements (one call per model)

| Call                                   | Input tok (cached) | Output tok | Reasoning tok | Answer tok | Est. USD |
| -------------------------------------- | ------------------ | ---------- | ------------- | ---------- | -------- |
| Wonder `low` (primary, the fixture)    | 7,066 (0)          | 3,405      | 1,740         | 1,665      | 0.0964   |
| Spark `medium` (fallback, the fixture) | 7,390 (0)          | 8,096      | 6,466         | 1,630      | 0.0436   |

- Latency was not measured separately: the Wonder recording run took ~21 s of test wall time
  including the replayed earlier steps (milliseconds), so the call took roughly 15–20 s.
- Spark reasons 3.7× as much as Wonder on the same catalog (as in P1-03) and costs 45% of it.
- **Per-run cost of this step: ~$0.10** for a 3-minute walkthrough with 6 photos. Input grows
  with candidates and photos (a 10-minute memo with 30 photos could reach ~20k input tokens,
  ~$0.08 of input alone); the answer grows with the number of `other:` facts. Worst case at the
  12,000 cap: Wonder $0.03 + $0.24, plus a fallback after a billed truncation ($0.06 at Spark's
  cap): **~$0.33**, which the $1.00 run cap absorbs. Typical with fallback after an
  unbilled HTTP error: ~$0.05.

### Quality on the recorded candidates

Both models produced the same structure and passed every code check:

| Check                                                    | Wonder `low`                                                | Spark `medium` |
| -------------------------------------------------------- | ----------------------------------------------------------- | -------------- |
| Verified groups proposed / accepted / escalated          | 61 / 61 / 0                                                 | 61 / 61 / 0    |
| Unknown IDs, values not cited, market facts cited        | 0 / 0 / 0                                                   | 0 / 0 / 0      |
| Citations stripped                                       | 2 (`value_differs`)                                         | 0              |
| Conflicts proposed / accepted                            | 1 / 1                                                       | 1 / 1          |
| Rejections proposed                                      | 0                                                           | 0              |
| `other:` candidates not accounted for (`not_reconciled`) | 0                                                           | 0              |
| Outcome: 106 candidates                                  | 98 verified, 2 conflicted, 6 rejected (5 opinions + the 95) | same           |

- **The planted living area** follows the basis rule, decided in code whatever the model says:
  form 92 NEN 2580 and turn 2's "92 vierkante meter" (NEN 2580) agree (`agreement`); turn 14's
  "zo'n 95 vierkante meter woonoppervlak" was extracted with basis `unspecified`, which is a
  different measure: rejected as `different_basis` with a basis note, **not a conflict**. This
  supersedes the P1-04 note's expectation ("same basis ⇒ conflict"): the speaker named no basis
  in that turn, and an unstated basis cannot contradict NEN 2580. The value stays visible on the
  sheet as a basis note (P4-06 can show it at Gate 1 as information). If the eval wants the
  planted value to be a conflict, the script must state "95 m² NEN 2580".
- **The one conflict** (both models): the walkthrough says the bedrooms have laminate flooring
  (`C43`), the bedroom photo shows carpet (`P04.R4`, `other:carpet_floor`). Correct for these
  inputs: the synthetic interiors were generated independently of the walkthrough, so photo and
  transcript disagree. Wonder labelled it `value_mismatch`, Spark `presence_mismatch`. It stops
  the recorded run at Gate 1, which the integration test asserts.
- **Wonder grouped the street and place form fields with the spoken full address**
  ("Kwartelhoflaan 27 in Zandmeer"). The values differ (street vs full address), so a strict
  "different value on one measure ⇒ conflict" rule would have raised a false conflict. Decision:
  for text facts under different keys, a different value is neither support nor contradiction
  (`value_differs`, the citation is dropped and the form fields stand on their own). Measurements
  and same-key text facts still escalate.
- Photo support Wonder chose: coat rack → cloakroom, herringbone floor → oak parquet, built-in
  wardrobe → fitted wardrobe. All presences, no measurement cited a photo.
- Both models verified every market-fact-free `other:` candidate as its own group (61 groups,
  one candidate each, plus the address group). The recording does not exercise grouping of the
  same fact stated twice, model rejections, or escalation; those paths are covered by the unit
  tests (`resolve.test.ts`).

### Replay and record

- `reconciliation-wonder.test.ts` (`api`) rebuilds the candidates by replaying the P2-06, P2-07,
  P2-08, and P1-05 cassettes (`createMetaReplay({ include })`), builds the catalog through the
  step's code, and replays `p2-09/reconciliation-wonder`. Assertions are structural plus the
  deterministic outcomes (living area, opinions, provenance); the model's judgment is not
  asserted.
- `reconciliation-fallback.test.ts` stubs Wonder with a truncated, billed answer (fetch wrapper
  in front of MSW; MSW's own `fetch(bypass(request))` passes through, so recording works) and
  replays `p2-09/reconciliation-spark-fallback`. It asserts the fallback, the recorded
  `modelRun`, and that the usage recorder saw both calls.
- `reconciliation.integration.test.ts` runs the step through the engine on the recorded answer
  (stops at Gate 1, then resumes), plus stubbed cases: no conflicts (gate released, run
  continues), a Wonder failure with a code conflict (two ledger rows, gate opened), and a
  superseded execution (one sheet, two billed calls).
- The catalog order is content-derived, so the request hash is the same from the replay test
  and from database rows. Changing the prompt, schema, catalog serialization, nl v1 facts, or
  the earlier steps' fixtures changes the hash; re-record (~$0.10 + ~$0.05):

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api reconciliation-wonder
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api reconciliation-fallback
```

### Live calls and cost (P2-09)

| #   | Call                                   | Input tok | Output tok (reasoning) | Est. USD   |
| --- | -------------------------------------- | --------- | ---------------------- | ---------- |
| 1   | Wonder `low`, reconciliation (fixture) | 7,066     | 3,405 (1,740)          | 0.0964     |
| 2   | Spark `medium`, fallback (fixture)     | 7,390     | 8,096 (6,466)          | 0.0436     |
|     | **Total (2 calls)**                    | 14,456    | 11,501 (8,206)         | **0.1400** |

Budget 0.25 USD (stop at 0.20). Costs from the price table ($4 / $20 per 1M on Wonder, $1.25 /
$4.25 on Spark); Meta's billing dashboard was not checked. No call failed or was retried.

## P3-01 — Creative copy

Status: done (pending review). Recorded 2026-10-28 against `ai@7.0.155`, `@ai-sdk/openai@4.0.104`.
Code: `apps/api/src/pipeline/creative/`; design in
[architecture.md §5 Creative copy](./architecture.md#5-run-pipeline).

### Request

- Spark through the AI SDK, `generateText` + `Output.object` (name `listing_copy`, strict
  `json_schema`), `metaProviderOptions({ reasoningEffort })`, model, effort, and
  `max_output_tokens` from the `creative` step (`muse-spark-1.3`, `medium`, 16,000; no fallback
  in v1). Meta echoed `effort: medium`, `store: false`, `strict: true`.
- Output schema: `{ portal: { paragraphs: [{ segments: [{ text, factIds }] }] }, social:
{ segments: [{ text, factIds }] } }`, with `factIds` items an enum of the request's 79 catalog
  IDs (`VF01…VF79`). Meta accepted the per-request enum inside nested arrays.
- Input: the system prompt (9 rules; phrasing rules built from the market's `flagged_phrasing`)
  and a compact JSON message (11.2k characters): language code and English name, the office
  tone, the market's currency, units, and area bases, the 79 catalog facts (key, profile label,
  value, unit, basis, `presence`, `seenIn`), the photo room list with the cover subject, and
  `revision: null`. 4,739 input tokens.
- Facts: the post-Gate-1 state of the recorded walkthrough, rebuilt without live calls from the
  P2-07/P2-08 cassettes and the P2-09 Wonder answer (`replayPostGateFacts`), with the one
  conflict (bedroom floor: "laminate floor" spoken, carpet in the photo) resolved by an `edit` to
  "carpet", so a `gate_decision` fact is in the input. 107 facts, 98 verified, grouped into 79
  IDs (71 stated, 8 photo presences).

### Measurements (one call per language)

| Call                           | Input tok (cached) | Output tok | Reasoning tok | Answer tok | Est. USD |
| ------------------------------ | ------------------ | ---------- | ------------- | ---------- | -------- |
| Spark `medium`, `en` (fixture) | 4,739 (0)          | 5,843      | 5,163         | 680        | 0.0308   |
| Spark `medium`, `nl` (fixture) | 4,739 (0)          | 7,094      | 6,254         | 840        | 0.0361   |

- Latency ~30 s per call (test wall time 30.5 s and 35.6 s, the replayed earlier steps take
  milliseconds; the cassette stores no timing).
- Reasoning is 88% of the output at `medium`; the answer itself is under 1k tokens. `low` would
  likely halve the cost; it is not measured, and the effort decision waits for P3-02's validator
  pass rate (architecture §5, P1-03 defaults), because a failed segment costs a revision loop.
- **Per-run cost of this step: ~$0.03–0.04** per draft (the architecture's extrapolated $0.03
  holds). Worst case at the 16,000 cap: $0.006 + $0.068 = **~$0.074**. P3-06's revision loops
  call the same function with the previous draft in the input (~+1k input tokens), so two
  revisions add ~$0.07–0.08.

### Quality on the recorded facts

| Check                                                      | `en`                  | `nl`                  |
| ---------------------------------------------------------- | --------------------- | --------------------- |
| Portal: paragraphs / segments / words                      | 3 / 14 / 169          | 3 / 19 / 139          |
| Social: segments / words                                   | 3 / 41                | 3 / 31                |
| Catalog IDs cited (of 79)                                  | 38                    | 48                    |
| Uncited segments (repairs needed)                          | 0                     | 0                     |
| Numbers in the text equal to a cited fact's value          | all (P3-02 validator) | all (P3-02 validator) |
| Market facts in the portal (label, area, year, VvE, lease) | 5/5                   | 5/5                   |
| Superlatives, promises, exclusionary phrasing              | none seen             | none seen             |
| Street or house number                                     | none (town named)     | none (town named)     |
| Language check                                             | `match` / `match`     | `match` / `match`     |
| Presence facts or the Gate 1 fact cited                    | no / no               | no / no               |

- Every number came from a cited fact: 92 m², 1987, label B, 34 m², 2021, 7 m², 14 m², 9 m²,
  €165, 6 m², floor 2, and in `nl` also 3 rooms, 2019, and 10 minutes by bike. No number was
  invented. The `primary_school_walking_distance` fact was used in `nl` ("basisschool op
  loopafstand") neutrally, without addressing families.
- Wording the verifier (P3-06) should look at: `en` "a 6 m² external storage is included"
  ("included" is not a fact) and `nl` "Grond in eigendom zonder erfpacht" ("in eigendom" is
  inferred from `ground_lease: false`; usually right in NL, but not stated).
- The office tone ("Warm and professional; short, concrete sentences.") made the Dutch copy
  telegraphic (article-less listing shorthand: "Woonoppervlakte 92 m². Energielabel B."); the
  English copy kept full sentences. Tone handling is the model's; the language check still
  matched, but a tone that asks for very short text pushes the caption towards the
  `inconclusive` threshold (4 function-word hits).
- The model segmented at sentence level and cited 1–5 IDs per segment; no segment needed the
  uncited-text repair, so that code path is covered by unit tests, not by the fixtures. Neither
  recording cited a photo presence or the Gate 1 decision, so the presence rule ("never count
  from a photo") is untested on live output.

### Replay and record

- `creative-copy-en.test.ts` and `creative-copy-nl.test.ts` (`api`, shared body in
  `recorded-copy.ts`) rebuild the post-Gate-1 facts from the P2-06, P2-07, P2-08, P1-05, and
  P2-09 cassettes (`createMetaReplay({ include })`), build the catalog and request through the
  step's code, and replay `p3-01/copy-en` / `p3-01/copy-nl`. Assertions: echoed settings,
  catalog = verified facts (gate decision included, opinions never), presences carry no counts,
  every segment cites verified facts only, both variants pass the language check, one ledger
  entry under $0.10. Wording is not asserted.
- `creative.integration.test.ts` runs the step through the engine on both recordings (artifact,
  claims mirroring the segments, the count-only event, usage, cascade on project deletion),
  plus no-call failures (nothing verified, a language the market does not offer) and a
  superseded execution (one copy, two billed calls). `generate.test.ts` covers the fallback
  policy and truncation on a stubbed fetch.
- One cassette per language, so each can be re-recorded alone. Changing the prompt, the output
  schema, the catalog serialization, the nl v1 profile, the office profile in `testing.ts`, or
  the earlier fixtures changes the hash; re-record (~$0.03–0.04 each):

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api creative-copy-en
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api creative-copy-nl
```

### Live calls and cost (P3-01)

| #   | Call                                | Input tok | Output tok (reasoning) | Est. USD   |
| --- | ----------------------------------- | --------- | ---------------------- | ---------- |
| 1   | Spark `medium`, copy `en` (fixture) | 4,739     | 5,843 (5,163)          | 0.0308     |
| 2   | Spark `medium`, copy `nl` (fixture) | 4,739     | 7,094 (6,254)          | 0.0361     |
|     | **Total (2 calls)**                 | 9,478     | 12,937 (11,417)        | **0.0668** |

Budget 0.60 USD (stop at 0.50). Costs from the price table ($1.25 / $4.25 per 1M); Meta's
billing dashboard was not checked. No call failed or was retried.

## P3-02 — Claim validator

Status: done (pending review). Pure code, no model calls ($0). Code:
`apps/api/src/pipeline/claims/`; rules and failure policy in
[architecture.md §5 Claim validator](./architecture.md#5-run-pipeline).

### Results on the recorded copy (P3-01 fixtures)

| Recording       | Segments | Number claims read | Findings | Result |
| --------------- | -------- | ------------------ | -------- | ------ |
| `p3-01/copy-en` | 17       | 15                 | 0        | `pass` |
| `p3-01/copy-nl` | 22       | 20                 | 0        | `pass` |

- This confirms P3-01's hand check in code: every number (92 m², 1987, floor 2, 34 m², 2021,
  7 m², 14 m², 9 m², €165, 6 m², and in `nl` 3 rooms, 2019, 10 minutes) equals a cited fact's
  value with a compatible unit. Validator pass rate at Spark `medium`: 39/39 segments (100%).
- Two readings needed a rule rather than luck: `nl` "€165 per maand" (currency prefix against the
  fact's `EUR`) and "station op 10 minuten fietsen" against
  `other:station_cycling_time_minutes = 10` with no unit field. Extraction puts units into
  free-text keys, so a unit-less fact takes the unit named by its key's last word; without that
  rule the `nl` recording would have failed on a correct claim.
- The wording P3-01 noted ("a 6 m² external storage is included", "Grond in eigendom") has no
  number problem and passes here; it remains the verifier's (P3-06) to judge.
- Seeded defects on the recorded segments (in the replay test) fail as intended: 92 → 95 m²
  (`number_not_in_facts`), "about"/"ca." before 92 m² (`approximate_number`), m² → m³
  (`unit_mismatch`), and the living-area citation removed (`number_not_in_facts`).
- The P1-03 verification sizing fixture (`synthetic-nl-apartment-copy.ts`, 26 segments, 21 number
  claims, "NEN 2580" in the text) also passes, as its header claims.

### Effort decision input

P1-03 kept creative copy at Spark `medium` until the validator pass rate was known. Both
recordings pass 100%, so the validator gives no reason to stay at `medium`; whether `low` (about
half the reasoning cost, ~$0.015–0.02 per draft) still writes numbers exactly is unmeasured. It
needs one recorded `low` call per language, run through this validator, before the definition
changes (a live-call task with a budget).

### Decisions worth remembering

- Number words are mapped and validated, not rejected outright; `one`/`een` are skipped
  (pronoun/article), so "one bathroom" against two bathrooms is the verifier's to catch. Ordinal
  words are claims, so "first-time buyers" or "the second bedroom" get flagged; that is a
  deliberate false-flag risk (one revision) over a missed floor claim.
- Approximate wording is flagged even around a matching number ("ruim 92 m²" for exactly 92).
- Photo facts never support a number, even when the per-photo count happens to be equal.
- A failed segment is kept and flagged for P3-06 and Gate 2, never dropped or regenerated in
  the creative step.

## P3-04 — Staging variants

**Decision (2026-10-29): `declutter` is off in v1** (`operation_kinds: [furnish]`). On `kitchen-cluttered` the edit removed the clutter but also redrew the worktop (longer and deeper) and the base cabinets under it. Worktops and cabinets are not fixed-element classes, so the integrity check passes the edit, and a buyer would be misled about the kitchen. Furnishing empty rooms keeps the original surfaces visible.

Status: done (pending review). Recorded 2026-10-28 against `openai@7.45.1`. Code:
`apps/api/src/pipeline/staging/`, `meta/images.ts` (`editMetaImageToolsOff`); design in
[architecture.md §5 Staging](./architecture.md#5-run-pipeline).

### Request

`editMetaImageToolsOff` sends the P1-08 body exactly: `model` (the step's `image_model`),
`prompt`, `images: [{ image_url: data:image/jpeg;base64,… }]`, `n: 1`, `size`, `output_format:
"jpeg"`, `response_format: "b64_json"`, `tool_enablement` with all three tools `false`.
`reasoning_strength` stays at the default `high` (P1-08). Usage is recorded with
`images = data.length` before the images are validated; a 2xx with an empty `data` is
`MetaImageEmptyError` (unbilled, `images: 0`).

- **`size` = the original's own `WxH`.** Meta accepted `1024x682` (not a "standard" size) and
  returned 1920×1280 for all five edits: it snaps to its own resolution near the requested
  aspect. Aspect change against the original 0.10%, the same as P1-06's `1536x1024`, well inside
  the integrity check's 3%. Sending the input's dimensions needs no size table and keeps working
  for 4:3 and portrait photos (untested live).
- **Prompt:** P1-06's wrapper ("Edit this photo: `<operation>`. Change nothing else: keep the
  camera angle, framing, walls, floor, ceiling, windows, doors, radiators, …") plus "built-in
  fittings", "do not place anything in front of a window or a door", and a no-add list (people,
  animals, text, logos, mirrors, pictures, screens, curtains, wardrobes, cabinets, tall
  furniture) from P1-07's false-rejection risks. Operation texts are a fixed catalog
  (`operations.ts`, `STAGING_PROMPT_VERSION` 1).

### Measured: five edits of the synthetic originals (the recording)

Selection from the P2-08 inventory with the cap raised to 5 (the definition's 3 selects the
first three). Inputs 1024×682 JPEG; every output 1920×1280 JPEG, ~0.4–0.6 MB as returned and
~150–250 KB after our re-encode (q85 mozjpeg).

| Photo (cover rank)            | Operation             | Input / output tok | Visual check                                                                                                                                  |
| ----------------------------- | --------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `living-empty` (1)            | `furnish_living_room` | 12,330 / 1,138     | Very good. Sofa, coffee table, rug; window, radiator, door, floor, framing unchanged.                                                         |
| `dining-chairs` (2)           | `furnish_dining_room` | 11,839 / 673       | Good. Chairs replaced (no cushions), table kept; window, door, radiator kept.                                                                 |
| `bedroom-empty` (3)           | `furnish_bedroom`     | 42,455 / 2,834     | Good. Bed and bedside table under the window; radiator partly hidden (the P1-07 containment case); wardrobe, door, window kept.               |
| `living-dining-cluttered` (4) | `declutter`           | 11,771 / 556       | Clutter fully removed; windows (2), radiators (2), door kept. **The table was redrawn larger and closer**, as in P1-06: unrequested geometry. |
| `kitchen-cluttered` (5)       | `declutter`           | 11,969 / 754       | Dishes, jars, kettle gone; window, radiator, door, cabinets kept. **The counter under the clutter was re-imagined** (longer, plain worktop).  |

- `hallway` (rank 6) was correctly `not_stageable`. No people, text, or logos appeared.
- **Declutter changes what was hidden.** Both declutter edits invented the surface that the
  clutter covered (a bigger table, a different counter run). Neither is a fixed-element class,
  so the integrity check will pass them; Gate 2 (original next to staged) is the only check.
  Furnishing was cleaner on these samples.
- One edit (`bedroom-empty`) reported ~3.5× the tokens of the others, like P1-06's slow group;
  the cause is still unknown (tools were off). Per-call latency was not captured: the
  measurement log line did not reach the console. The first session ran 4 edits, 3 in flight,
  in 24 s of wall time.

### Recording incident and fixture

- The first record run (3 edits in flight, ~1.3 MB JSON bodies) failed one request inside MSW's
  record-mode passthrough with `ERR_SSL_TOO_LONG` (`asn1 … too long`), which the SDK surfaced as
  `500 terminated`. Four edits had succeeded and were written. To avoid paying for them again,
  the partial cassette was served read-only as an `include` while the fifth edit was recorded
  alone, then the two were merged with `readCassette`/`writeCassette` (scratch script, not
  committed). Unexplained; if it recurs, record with fewer edits in flight.
- **The image blobs in `fixtures/meta/p3-04/staging.files/` are downscaled 2× (960×640, JPEG
  q80, Meta's XMP kept) after recording**: 2.37 MB → 260 KB. Replay therefore serves smaller
  images than the API returned; the tests assert aspect ratios and formats, never pixel sizes,
  and the live dimensions are the ones in the table above. Re-recording overwrites the blobs
  with full-size ones; downscale again before committing.

### Replay and record

`staging.test.ts` (`api`) runs the vision inventory core on the six samples from the P2-08 and
P1-05 cassettes (`include`, never re-sent), plans with a cap of 5, and edits; the integration
test runs vision then staging through the engine with the definition's cap of 3, whose requests
are the first three recorded. Changing an operation text, the wrapper, the samples, or the
vision recordings changes the request hashes and needs a re-record ($0.05):

```sh
RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api staging.test
```

`P3_04_EXPORT_DIR=<dir>` writes each stored staged image there (also in replay).

### Live calls and cost (P3-04)

| #   | Call                                                        | Images  | Est. USD          |
| --- | ----------------------------------------------------------- | ------- | ----------------- |
| 1–4 | Record run 1: four edits                                    | 4       | 0.04              |
| 5   | Record run 1: one edit lost to the MSW error (no response)  | 0–1     | 0–0.01            |
| 6   | Record run 2: the remaining edit                            | 1       | 0.01              |
|     | Replayed: 6 Spark + 12 privacy + 12 evidence calls (vision) | –       | 0                 |
|     | **Total**                                                   | **5–6** | **0.05 (≤ 0.06)** |

Budget 0.30 USD (stop at 0.25). Cost from the price table ($0.01 per returned image); Meta's
billing dashboard was not checked, so whether call 5 reached the API and was billed is unknown.
