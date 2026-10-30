import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createDbClient, type DbClient } from '../db/client.ts';
import type { Env } from '../env.ts';
import { bootDefinitions } from '../definitions/boot.ts';
import type { Logger } from '../logger.ts';
import { createMetaClients } from '../meta/clients.ts';
import { cassettePath } from '../meta/fixtures.ts';
import { createMetaReplay, type MetaReplay } from '../meta/replay.ts';
import { createStepHandlers } from '../pipeline/handlers.ts';
import { startWorkerRuntime, type WorkerRuntime } from '../runs/worker-runtime.ts';
import type { Storage } from '../storage/storage.ts';
import { createPriceTableCostEstimator } from '../usage/ledger.ts';
import { preparePhoto } from '../upload/prepare.ts';
import { assertNotProduction, DEV_REPLAY_DAILY_CAP_USD, DevSeedError } from './dev-seed-run.ts';
import { fixtureMatchOptions } from './execute.ts';
import { createFixtureImageAliases } from './image-aliases.ts';
import { loadProject } from './project.ts';
import { createUploadPhotoAliaser } from './upload-aliases.ts';

// `npm run dev:worker:replay` (docs/architecture.md §5 "Development seed"): the development
// worker for runs made by `npm run dev:seed`. It registers the production step handlers, but its
// Meta clients can only talk to the project's cassette through MSW, with a placeholder key: a
// request the cassette does not hold fails the step at once (non-retryable, with the
// `REPLAY_MISS_REASON` of `runs/steps.ts`), and any other host gets a network error. So a run
// continued after a gate decision makes zero live calls. A cassette may hold several recorded
// Gate 1 paths (`recorded-paths.ts`); the worker serves whichever the decisions lead to.
//
// This is a separate entry from `worker.ts` on purpose: it imports MSW (a dev dependency that
// the production image does not contain), refuses NODE_ENV=production, and needs the committed
// `fixtures/` (also absent from the production image). It works the default pg-boss schema, as
// the API's gate services enqueue there, so run it instead of `dev:worker`, never beside it.

export interface ReplayWorkerOptions {
  readonly env: Pick<Env, 'DATABASE_URL' | 'STORAGE_DIR' | 'DEFINITIONS_DIR'>;
  readonly projectDir: string;
  readonly storage: Storage;
  readonly logger: Logger;
  /** `NODE_ENV`; anything but production is accepted. */
  readonly nodeEnv: string | undefined;
  /**
   * Also name photos uploaded through the web app after the worker started, by their position
   * (`upload-aliases.ts`), so a project created in the UI with the project directory's photos can
   * be replayed. Off by default: the seed's photos are named from the files themselves.
   */
  readonly uploadedPhotos?: boolean;
}

export interface ReplayWorker {
  readonly runtime: WorkerRuntime;
  readonly replay: MetaReplay;
  readonly cassette: string;
  /** The cassette's file (under the project's `fixtureDir`, default `fixtures/meta/`). */
  readonly cassetteFile: string;
  /** Stops the worker, then the replay (requests of in-flight steps need it until they settle). */
  shutdown(): Promise<void>;
}

/**
 * Names the project's photos in the replay as the seed did: a request is matched on a hash that
 * replaces each image's bytes with `photo:<sha256 of the uploaded file>`. The seed stored the
 * result of `preparePhoto` (sharp re-encode), which is deterministic on one machine, so
 * preparing the same files here yields the same stored bytes without reading the database.
 */
async function registerProjectPhotos(
  project: Awaited<ReturnType<typeof loadProject>>,
  aliases: ReturnType<typeof createFixtureImageAliases>,
): Promise<readonly string[]> {
  const vision = project.service.steps.find((step) => step.agent === 'vision');
  const sourceSha256s: string[] = [];
  for (const photo of project.photos) {
    const source = await readFile(photo.path);
    const prepared = await preparePhoto(photo.path);
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    sourceSha256s.push(sourceSha256);
    await aliases.registerPhoto(
      { bytes: new Uint8Array(prepared.data), width: prepared.width, height: prepared.height },
      sourceSha256,
      vision?.agent === 'vision' ? vision.classification_long_edge_px : undefined,
    );
  }
  return sourceSha256s;
}

export async function startReplayWorker(options: ReplayWorkerOptions): Promise<ReplayWorker> {
  assertNotProduction('dev:worker:replay', options.nodeEnv);
  const { logger } = options;
  const registry = await bootDefinitions({ dir: options.env.DEFINITIONS_DIR, logger });
  const project = await loadProject(options.projectDir, registry, (id, version) =>
    registry.getService(id, version),
  );
  const cassette = project.fixture;
  if (cassette === null) {
    throw new DevSeedError(`${project.dir} has no "fixture" cassette; the worker replays one`);
  }
  const cassetteFile = cassettePath(cassette, project.fixturesDir);
  try {
    await access(cassetteFile);
  } catch {
    throw new DevSeedError(`No recorded run at ${cassetteFile}`);
  }

  const aliases = createFixtureImageAliases();
  const sourceSha256s = await registerProjectPhotos(project, aliases);
  const vision = project.service.steps.find((step) => step.agent === 'vision');
  // Only used to name uploaded photos; the seed's own photos never need it.
  let aliasDb: DbClient | undefined;
  let beforeImageAlias: (() => Promise<void>) | undefined;
  if (options.uploadedPhotos === true) {
    aliasDb = createDbClient(options.env.DATABASE_URL, { logger });
    beforeImageAlias = createUploadPhotoAliaser({
      db: aliasDb.db,
      storage: options.storage,
      aliases,
      sourceSha256s,
      classificationLongEdgePx:
        vision?.agent === 'vision' ? vision.classification_long_edge_px : undefined,
    });
  }
  const match = {
    ...fixtureMatchOptions(aliases),
    ...(beforeImageAlias === undefined ? {} : { beforeImageAlias }),
  };
  // Replay mode is fixed here; there is no flag, and the real MODEL_API_KEY is never read.
  const replay = createMetaReplay({
    cassette,
    fixturesDir: project.fixturesDir,
    mode: 'replay',
    match,
    onInteraction: aliases.onInteraction,
  });
  await replay.start();

  const estimateCost = createPriceTableCostEstimator();
  let runtime: WorkerRuntime;
  try {
    runtime = await startWorkerRuntime({
      env: { DATABASE_URL: options.env.DATABASE_URL, DAILY_BUDGET_USD: DEV_REPLAY_DAILY_CAP_USD },
      logger,
      engine: {
        registry,
        handlers: createStepHandlers({ storage: options.storage, markets: registry }),
        createMetaClients: (usage) =>
          createMetaClients({ apiKey: replay.apiKey, usage, estimateCost, logger }),
      },
    });
  } catch (error) {
    await replay.stop();
    await aliasDb?.close();
    throw error;
  }

  let stopping: Promise<void> | undefined;
  async function stop(): Promise<void> {
    try {
      await runtime.shutdown();
    } finally {
      await replay.stop();
      await aliasDb?.close();
    }
  }
  return {
    runtime,
    replay,
    cassette,
    cassetteFile,
    shutdown() {
      stopping ??= stop();
      return stopping;
    },
  };
}
