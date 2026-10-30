// Test and dev-tool only: imports `msw` (a dev dependency). Used by tests and by the headless
// pipeline CLI (`apps/api/src/cli/`); never import this from server or worker code.
import { access } from 'node:fs/promises';
import { bypass, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { META_BASE_URL } from './clients.ts';
import {
  cassettePath,
  describeRequest,
  FIXTURE_FORMAT_VERSION,
  interactionFromResponse,
  matchKey,
  META_FIXTURES_DIR,
  readCassette,
  responseFromInteraction,
  writeCassette,
  type Interaction,
  type MatchOptions,
} from './fixtures.ts';
import { REPLAY_MISS_HEADER, REPLAY_MISS_VALUE } from './service-errors.ts';

export type ReplayMode = 'record' | 'replay';

/** `RECORD=1` records live responses; anything else replays fixtures. */
export function replayModeFromEnv(env: NodeJS.ProcessEnv = process.env): ReplayMode {
  return env['RECORD'] === '1' ? 'record' : 'replay';
}

/** Sent in replay mode, where no request reaches the network. Never a real credential. */
export const REPLAY_PLACEHOLDER_API_KEY = 'replay-placeholder-key';

export class ReplayError extends Error {
  override name = 'ReplayError';
}

export interface MetaReplayOptions {
  /** Fixture name under `fixtures/meta/`, e.g. `p1-01/spark-text-ai-sdk`. */
  readonly cassette: string;
  readonly mode?: ReplayMode;
  readonly fixturesDir?: string;
  readonly baseURL?: string;
  /** Source of `MODEL_API_KEY` in record mode. */
  readonly env?: NodeJS.ProcessEnv;
  /** Request matching options; must be identical when recording and replaying a cassette. */
  readonly match?: MatchOptions;
  /**
   * Further cassettes served read-only in both modes and never written, for tests that chain
   * steps (e.g. the intake transcript feeding fact extraction): recording the later step then
   * neither repeats nor re-records the earlier step's call. Matched before `cassette`.
   */
  readonly include?: readonly string[];
  /**
   * Record mode only: serve requests the cassette already answers instead of calling the live
   * API, record the rest, and write back only the interactions this session used. Re-running a
   * long recording after a fix then pays only for the requests that changed. A missing cassette
   * starts empty.
   */
  readonly extend?: boolean;
  /**
   * With `extend`: write back every interaction of the cassette, not only those this session
   * used. A cassette holding several recorded Gate 1 paths (`apps/api/src/cli/recorded-paths.ts`)
   * needs this: each session follows one path, and pruning would drop the others. Stale
   * interactions then stay until the cassette is deleted and re-recorded.
   */
  readonly retainUnused?: boolean;
  /**
   * Called with every interaction before its response is returned to the SDK (replayed,
   * included, or freshly recorded), so a caller can derive state from a response before the code
   * under test sees it (e.g. register an image alias for what the code will send next).
   */
  readonly onInteraction?: (interaction: Interaction) => void | Promise<void>;
}

export interface MetaReplay {
  readonly mode: ReplayMode;
  /** The real key in record mode, a placeholder in replay mode. */
  readonly apiKey: string;
  /** Requests that had no fixture (replay) or went to a non-Meta host (both modes). */
  readonly unmatched: readonly string[];
  /** Requests forwarded to the live API (record mode only; always 0 in replay mode). */
  readonly liveRequestCount: number;
  /** Requests answered from a cassette (the replayed one, an included one, or an extended one). */
  readonly servedFromCassetteCount: number;
  start(): Promise<void>;
  /** Stops interception; in record mode, writes the cassette. */
  stop(): Promise<void>;
  /** Throws if any request was unmatched, even if the caller swallowed the SDK error. */
  assertAllMatched(): void;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

const recordEnvSchema = z.object({ MODEL_API_KEY: z.string().min(1) });

function recordApiKey(env: NodeJS.ProcessEnv): string {
  const parsed = recordEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ReplayError(
      'MODEL_API_KEY is required when RECORD=1; load it with node --env-file=.env (docs/model-notes.md)',
    );
  }
  return parsed.data.MODEL_API_KEY;
}

/**
 * MSW record/replay for the Meta API, shared by both SDKs (both call `fetch`).
 *
 * Replay never touches the network: Meta requests without a fixture get a non-retryable 404
 * whose message names the request, and requests to any other host fail with a network error.
 * Record mode forwards Meta requests to the live API and stores 2xx responses only, so SDK
 * retries after a 429/5xx never end up in a fixture.
 */
export function createMetaReplay(options: MetaReplayOptions): MetaReplay {
  const mode = options.mode ?? replayModeFromEnv(options.env);
  const file = cassettePath(options.cassette, options.fixturesDir ?? META_FIXTURES_DIR);
  const origin = new URL(options.baseURL ?? META_BASE_URL).origin;
  const apiKey =
    mode === 'record' ? recordApiKey(options.env ?? process.env) : REPLAY_PLACEHOLDER_API_KEY;

  const interactions = new Map<string, Interaction>();
  const included = new Map<string, Interaction>();
  const includedFiles = (options.include ?? []).map((name) =>
    cassettePath(name, options.fixturesDir ?? META_FIXTURES_DIR),
  );
  const unmatched: string[] = [];
  /** Keys used in this session; with `extend`, only these are written back. */
  const used = new Set<string>();
  let liveRequestCount = 0;
  let servedFromCassetteCount = 0;

  async function serve(interaction: Interaction, fromCassette: boolean): Promise<Response> {
    if (fromCassette) servedFromCassetteCount += 1;
    await options.onInteraction?.(interaction);
    return responseFromInteraction(interaction);
  }

  const metaHandler = http.all(`${origin}/*`, async ({ request }) => {
    const descriptor = await describeRequest(request.clone(), options.match);
    const key = matchKey(descriptor);

    const fixed = included.get(key);
    if (fixed !== undefined) {
      return serve(fixed, true);
    }

    if (mode === 'record') {
      const known = options.extend === true ? interactions.get(key) : undefined;
      if (known !== undefined) {
        used.add(key);
        return serve(known, true);
      }
      liveRequestCount += 1;
      const live = await fetch(bypass(request));
      if (live.status < 200 || live.status > 299) {
        return live;
      }
      const interaction = await interactionFromResponse(descriptor, live);
      // Identical requests replay the same response; the latest recording wins.
      interactions.set(key, interaction);
      used.add(key);
      return serve(interaction, false);
    }

    const interaction = interactions.get(key);
    if (interaction !== undefined) {
      return serve(interaction, true);
    }
    const message =
      `No recorded Meta API fixture for ${key} in ${file}. ` +
      'The request changed or was never recorded; re-record with RECORD=1 (docs/model-notes.md).';
    unmatched.push(message);
    return HttpResponse.json(
      { error: { message, type: 'fixture_not_found', code: 'fixture_not_found' } },
      // 404 is non-retryable in both SDKs; `x-should-retry` makes it explicit for the openai SDK,
      // and the miss header lets the run engine name the cause (`runs/steps.ts`).
      {
        status: 404,
        headers: { 'x-should-retry': 'false', [REPLAY_MISS_HEADER]: REPLAY_MISS_VALUE },
      },
    );
  });

  const blockOtherHosts = http.all('*', ({ request }) => {
    unmatched.push(`Blocked request to a non-Meta host: ${request.method} ${request.url}`);
    return HttpResponse.error();
  });

  const server = setupServer(metaHandler, blockOtherHosts);
  let started = false;

  return {
    mode,
    apiKey,
    unmatched,
    get liveRequestCount() {
      return liveRequestCount;
    },
    get servedFromCassetteCount() {
      return servedFromCassetteCount;
    },
    async start() {
      if (started) throw new ReplayError('Meta replay is already started');
      for (const includedFile of includedFiles) {
        const cassette = await readCassette(includedFile);
        for (const interaction of cassette.interactions) {
          included.set(matchKey(interaction.request), interaction);
        }
      }
      if (mode === 'replay' || (options.extend === true && (await fileExists(file)))) {
        const cassette = await readCassette(file);
        for (const interaction of cassette.interactions) {
          interactions.set(matchKey(interaction.request), interaction);
        }
      }
      server.listen({ onUnhandledFrame: 'error' });
      started = true;
    },
    async stop() {
      if (!started) return;
      server.close();
      started = false;
      if (mode === 'record') {
        if (options.extend === true && options.retainUnused !== true) {
          for (const key of [...interactions.keys()]) {
            if (!used.has(key)) interactions.delete(key);
          }
        }
        if (interactions.size === 0) {
          throw new ReplayError(`RECORD=1 captured no successful responses; ${file} not written`);
        }
        await writeCassette(file, {
          formatVersion: FIXTURE_FORMAT_VERSION,
          cassette: options.cassette,
          recordedAt: new Date().toISOString(),
          interactions: [...interactions.values()].sort((a, b) =>
            matchKey(a.request).localeCompare(matchKey(b.request)),
          ),
        });
      }
    },
    assertAllMatched() {
      if (unmatched.length > 0) {
        throw new ReplayError(`Unmatched requests:\n${unmatched.join('\n')}`);
      }
    },
  };
}
