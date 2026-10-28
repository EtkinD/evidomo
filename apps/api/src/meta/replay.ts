// Test-only: imports `msw` (a dev dependency). Never import this from server or worker code.
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
}

export interface MetaReplay {
  readonly mode: ReplayMode;
  /** The real key in record mode, a placeholder in replay mode. */
  readonly apiKey: string;
  /** Requests that had no fixture (replay) or went to a non-Meta host (both modes). */
  readonly unmatched: readonly string[];
  start(): Promise<void>;
  /** Stops interception; in record mode, writes the cassette. */
  stop(): Promise<void>;
  /** Throws if any request was unmatched, even if the caller swallowed the SDK error. */
  assertAllMatched(): void;
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

  const metaHandler = http.all(`${origin}/*`, async ({ request }) => {
    const descriptor = await describeRequest(request.clone(), options.match);
    const key = matchKey(descriptor);

    const fixed = included.get(key);
    if (fixed !== undefined) {
      return responseFromInteraction(fixed);
    }

    if (mode === 'record') {
      const live = await fetch(bypass(request));
      if (live.status < 200 || live.status > 299) {
        return live;
      }
      const interaction = await interactionFromResponse(descriptor, live);
      // Identical requests replay the same response; the latest recording wins.
      interactions.set(key, interaction);
      return responseFromInteraction(interaction);
    }

    const interaction = interactions.get(key);
    if (interaction !== undefined) {
      return responseFromInteraction(interaction);
    }
    const message =
      `No recorded Meta API fixture for ${key} in ${file}. ` +
      'The request changed or was never recorded; re-record with RECORD=1 (docs/model-notes.md).';
    unmatched.push(message);
    return HttpResponse.json(
      { error: { message, type: 'fixture_not_found', code: 'fixture_not_found' } },
      // 404 is non-retryable in both SDKs; the header makes it explicit for the openai SDK.
      { status: 404, headers: { 'x-should-retry': 'false' } },
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
    async start() {
      if (started) throw new ReplayError('Meta replay is already started');
      for (const includedFile of includedFiles) {
        const cassette = await readCassette(includedFile);
        for (const interaction of cassette.interactions) {
          included.set(matchKey(interaction.request), interaction);
        }
      }
      if (mode === 'replay') {
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
