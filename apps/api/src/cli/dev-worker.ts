import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DefinitionError } from '../definitions/loader.ts';
import { EnvError, loadEnv } from '../env.ts';
import { createLogger } from '../logger.ts';
import { shutdownOnSignals } from '../runs/worker-runtime.ts';
import { createLocalStorage } from '../storage/local.ts';
import { assertNotProduction, DevSeedError, ProductionRefusedError } from './dev-seed-run.ts';
import { ProjectDirError } from './project.ts';
import { startReplayWorker } from './replay-worker.ts';

// `npm run dev:worker:replay -- [project-dir]` (docs/architecture.md §5 "Development seed").
// Exit codes: 0 stopped by a signal; 1 failed to start; 2 invalid invocation, environment, or
// production.

const USAGE = `Usage: npm run dev:worker:replay -- [project-dir]

The development worker for runs seeded by "npm run dev:seed": it runs the real pipeline steps,
but every Meta request is answered from the project's cassette (default project:
fixtures/projects/synthetic-walkthrough), so continuing a run after a gate decision makes zero
model calls. Use it instead of "npm run dev:worker", never beside it: both would work the same
queue. Development only; refuses NODE_ENV=production.

Only decisions the recording holds can be replayed: decide Gate 1 as "npm run dev:seed" prints.`;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEFAULT_PROJECT = path.join(REPO_ROOT, 'fixtures', 'projects', 'synthetic-walkthrough');

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  try {
    assertNotProduction('dev:worker:replay', process.env['NODE_ENV']);
  } catch (error) {
    if (error instanceof ProductionRefusedError) fail(error.message, 2);
    throw error;
  }
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' } } });
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`, 2);
  }
  if (parsed.values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const [projectArg, ...extra] = parsed.positionals;
  if (extra.length > 0) fail(USAGE, 2);
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  const projectDir = projectArg === undefined ? DEFAULT_PROJECT : path.resolve(cwd, projectArg);

  let env;
  try {
    env = loadEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError) fail(error.message, 2);
    throw error;
  }
  const logger = createLogger(env);
  try {
    const worker = await startReplayWorker({
      env,
      projectDir,
      storage: createLocalStorage({ rootDir: env.STORAGE_DIR }),
      logger,
      nodeEnv: env.NODE_ENV,
    });
    shutdownOnSignals({ engine: worker.runtime.engine, shutdown: () => worker.shutdown() }, logger);
    process.stderr.write(
      `Replay worker started: cassette ${worker.cassette}, zero live model calls (Ctrl-C to stop)\n`,
    );
  } catch (error) {
    if (error instanceof ProjectDirError || error instanceof DefinitionError) {
      fail(error.message, 2);
    }
    if (error instanceof DevSeedError) fail(error.message, 1);
    logger.fatal({ err: error }, 'replay worker failed to start');
    process.exit(1);
  }
}

await main();
