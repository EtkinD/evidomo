import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import type { LanguageModel, LanguageModelCallEndEvent } from 'ai';
import OpenAI, { type ClientOptions } from 'openai';
import type { Logger } from 'pino';
import {
  usageEntryFromAiSdkCall,
  usageEntryFromOpenAIResult,
  type CostEstimator,
  type UsageRecorder,
} from './usage.ts';

export const META_BASE_URL = 'https://api.meta.ai/v1';

/** SDK defaults (2 retries) made explicit so both clients share one policy. */
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_TIMEOUT_MS = 180_000;

export class MetaConfigError extends Error {
  override name = 'MetaConfigError';
}

export class ForbiddenModelError extends Error {
  override name = 'ForbiddenModelError';
}

const CONTRIBUTOR_SUFFIX = '-contributor';

/** Contributor-mode models may train on inputs; the product uses Standard mode only. */
export function assertStandardModelId(modelId: string): void {
  if (modelId.endsWith(CONTRIBUTOR_SUFFIX)) {
    throw new ForbiddenModelError(
      `Model "${modelId}" is a Contributor-mode model; only Standard-mode models are allowed`,
    );
  }
}

function modelIdFromBody(body: unknown): string | undefined {
  if (typeof body === 'string') {
    // Cheap pre-check so large (base64 image) bodies are parsed only when they could match.
    if (!body.includes(CONTRIBUTOR_SUFFIX)) return undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null && 'model' in parsed) {
        return typeof parsed.model === 'string' ? parsed.model : undefined;
      }
    } catch {
      // Not JSON: no `model` field to check. The request goes out unchanged.
    }
    return undefined;
  }
  if (body instanceof FormData) {
    const model = body.get('model');
    return typeof model === 'string' ? model : undefined;
  }
  return undefined;
}

/**
 * Voice Transcribe sends its settings, including `model`, as a JSON file part named `request`
 * rather than as a form field, so multipart bodies need this second, asynchronous check.
 */
async function modelIdFromJsonPart(body: unknown): Promise<string | undefined> {
  if (!(body instanceof FormData)) return undefined;
  const part = body.get('request');
  if (!(part instanceof Blob)) return undefined;
  return modelIdFromBody(await part.text());
}

/**
 * The fetch both SDKs use. It resolves `globalThis.fetch` per request rather than at client
 * construction (the `openai` SDK captures it in its constructor), so MSW interception installed
 * after the clients exist still applies. It also refuses Contributor-mode models for every
 * request, whichever SDK or call site built it.
 */
const metaFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const modelId = modelIdFromBody(init?.body) ?? (await modelIdFromJsonPart(init?.body));
  if (modelId !== undefined) assertStandardModelId(modelId);
  return globalThis.fetch(input, init);
};

function toOpenAILogger(logger: Logger): NonNullable<ClientOptions['logger']> {
  const child = logger.child({ component: 'openai-sdk' });
  return {
    error: (message, ...details) => child.error({ details }, message),
    warn: (message, ...details) => child.warn({ details }, message),
    info: (message, ...details) => child.info({ details }, message),
    debug: (message, ...details) => child.debug({ details }, message),
  };
}

export interface MetaClientOptions {
  /** `MODEL_API_KEY`. Required; replay tests pass a placeholder. */
  readonly apiKey: string | undefined;
  readonly usage: UsageRecorder;
  readonly estimateCost?: CostEstimator;
  readonly logger?: Logger;
  readonly baseURL?: string;
  readonly maxRetries?: number;
  /**
   * Timeout in ms. The `openai` SDK applies it per attempt; the AI SDK applies it to the whole
   * call including retries (its `timeout` option has no per-attempt variant).
   */
  readonly timeoutMs?: number;
}

/** Options to spread into every AI SDK call (`generateText`, `streamText`, ...). */
export interface AiSdkCallOptions {
  readonly maxRetries: number;
  readonly timeout: number;
  readonly onLanguageModelCallEnd: (event: LanguageModelCallEndEvent) => void;
}

export interface MetaClients {
  /** AI SDK provider, the primary client. Prefer `languageModel()` for language models. */
  readonly provider: OpenAIProvider;
  /** `openai` SDK client for endpoints the AI SDK does not cover. */
  readonly openai: OpenAI;
  /** A Responses API language model; rejects Contributor-mode IDs. */
  languageModel(modelId: string): LanguageModel;
  /** Retry/timeout policy and usage capture for one AI SDK call. */
  aiSdkCallOptions(): AiSdkCallOptions;
  /** Runs one `openai` SDK call, measures latency, and records its usage. */
  captureOpenAIUsage<T>(call: () => Promise<T>): Promise<T>;
}

export function createMetaClients(options: MetaClientOptions): MetaClients {
  const { apiKey, usage, estimateCost, logger } = options;
  if (apiKey === undefined || apiKey === '') {
    throw new MetaConfigError('MODEL_API_KEY is not set; the Meta API clients cannot be created');
  }
  const baseURL = options.baseURL ?? META_BASE_URL;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Explicit values everywhere: both SDKs otherwise fall back to OPENAI_* environment variables.
  const provider = createOpenAI({ name: 'meta', baseURL, apiKey, fetch: metaFetch });
  const openai = new OpenAI({
    apiKey,
    baseURL,
    organization: null,
    project: null,
    maxRetries,
    timeout: timeoutMs,
    fetch: metaFetch,
    logLevel: 'warn',
    ...(logger === undefined ? {} : { logger: toOpenAILogger(logger) }),
  });

  return {
    provider,
    openai,
    languageModel(modelId) {
      assertStandardModelId(modelId);
      return provider.responses(modelId);
    },
    aiSdkCallOptions() {
      return {
        maxRetries,
        timeout: timeoutMs,
        onLanguageModelCallEnd: (event) => {
          usage.record(usageEntryFromAiSdkCall(event, estimateCost));
        },
      };
    },
    async captureOpenAIUsage(call) {
      const startedAt = performance.now();
      const result = await call();
      usage.record(usageEntryFromOpenAIResult(result, performance.now() - startedAt, estimateCost));
      return result;
    },
  };
}
