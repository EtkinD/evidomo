import express, { type Express } from 'express';
import type { HealthStatus } from '@evidomo/shared';
import { authConfigFromEnv, type AuthConfig, type AuthRateLimits } from './auth/config.ts';
import { createAuthRouter } from './auth/routes.ts';
import { createSessionMiddleware } from './auth/session.ts';
import type { DbClient } from './db/client.ts';
import type { DefinitionRegistry } from './definitions/loader.ts';
import { createDefinitionRouter } from './definitions/routes.ts';
import type { Env } from './env.ts';
import { createClaimAuditGate } from './gates/claim-audit.ts';
import { createFactConflictsGate } from './gates/fact-conflicts.ts';
import { createGateRouter } from './gates/routes.ts';
import { createErrorHandler } from './http/errors.ts';
import { rejectCrossOrigin } from './http/guards.ts';
import type { Logger } from './logger.ts';
import { createProjectApiRouter, type AppProjectDeps } from './projects/compose.ts';
import type { RunEngine } from './runs/engine.ts';
import { createRunEventSource } from './run-api/event-source.ts';
import { createRunEventStreams, type RunEventStreamOptions } from './run-api/event-stream.ts';
import { createProjectRunsRouter, createRunApiRouter } from './run-api/routes.ts';
import { createRunApiService } from './run-api/service.ts';
import type { Storage } from './storage/storage.ts';

export interface AppConfig {
  auth: AuthConfig;
  /** Express `trust proxy` hop count; 0 disables X-Forwarded-For entirely. */
  trustProxyHops: number;
}

export function appConfigFromEnv(
  env: Pick<Env, 'APP_ORIGIN' | 'SESSION_TTL_DAYS' | 'TRUST_PROXY_HOPS'>,
  rateLimits?: AuthRateLimits,
): AppConfig {
  return {
    auth: authConfigFromEnv(env, rateLimits),
    trustProxyHops: env.TRUST_PROXY_HOPS,
  };
}

/** What the run routes need from the run engine and the definitions loaded at boot. */
export interface AppRunDeps {
  /** Gate decisions resume the run in their own transaction (no workers in the API process). */
  engine: Pick<RunEngine, 'resumeAfterGate' | 'startRun'>;
  markets: Pick<DefinitionRegistry, 'getMarket'>;
  /** The run snapshot lists the definition's steps and its cost cap. */
  services: Pick<DefinitionRegistry, 'getService'>;
  /** Aborted on shutdown: open event streams end so the HTTP server can close. */
  shutdownSignal?: AbortSignal;
  eventStream?: RunEventStreamOptions;
}

export interface AppDeps {
  db: Pick<DbClient, 'ping' | 'db'>;
  logger: Logger;
  config: AppConfig;
  runs: AppRunDeps;
  /** Uploaded materials and generated files: written by uploads, read by evidence and export. */
  storage: Storage;
  projects: AppProjectDeps;
}

export function createApp({ db, logger, config, runs, storage, projects }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // A hop count, not `true`: only the entry Caddy appends is believed, so a client cannot
  // choose its own rate-limit bucket by sending X-Forwarded-For.
  app.set('trust proxy', config.trustProxyHops);

  // Before body parsing, so a cross-origin request is refused without reading its body.
  app.use('/api', rejectCrossOrigin(config.auth.appOrigin));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/healthz', async (_req, res) => {
    let database: HealthStatus['checks']['database'] = 'ok';
    try {
      await db.ping();
    } catch (error) {
      logger.error({ err: error }, 'health check: database ping failed');
      database = 'unavailable';
    }

    const body: HealthStatus = {
      status: database === 'ok' ? 'ok' : 'degraded',
      checks: { database },
    };
    res.status(database === 'ok' ? 200 : 503).json(body);
  });

  // Project-scoped routers (P4-02 onwards) mount below with `session.requireUser` and read
  // the user through `currentUser(req)`.
  const session = createSessionMiddleware({ db: db.db, config: config.auth });
  app.use('/api/auth', createAuthRouter({ db: db.db, config: config.auth, logger, session }));
  const gate = createFactConflictsGate({ db: db.db, engine: runs.engine, markets: runs.markets });
  const claimAudit = createClaimAuditGate({
    db: db.db,
    engine: runs.engine,
    markets: runs.markets,
  });
  const runApi = createRunApiService({ db: db.db, services: runs.services });
  const streams = createRunEventStreams({
    source: createRunEventSource(db.db),
    logger,
    ...(runs.eventStream === undefined ? {} : { options: runs.eventStream }),
    ...(runs.shutdownSignal === undefined ? {} : { shutdownSignal: runs.shutdownSignal }),
  });
  // Before the gate router: its `router.use` (session, JSON guard, no-store) would otherwise run
  // on every run API request too. These routes guard themselves per route.
  app.use('/api/runs', createRunApiRouter({ service: runApi, streams, storage, session, logger }));
  app.use('/api/projects', createProjectRunsRouter({ service: runApi, session }));
  app.use('/api/runs', createGateRouter({ gate, claimAudit, session, logger }));
  app.use('/api', createDefinitionRouter({ definitions: projects.definitions, session }));
  app.use(
    '/api/projects',
    createProjectApiRouter({
      ...projects,
      db: db.db,
      logger,
      session,
      storage,
      engine: runs.engine,
    }),
  );

  app.use(createErrorHandler(logger));

  return app;
}
