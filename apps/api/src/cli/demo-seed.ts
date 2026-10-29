import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createDbClient } from '../db/client.ts';
import { DefinitionError } from '../definitions/loader.ts';
import { EnvError, loadEnv } from '../env.ts';
import { createLogger } from '../logger.ts';
import { createLocalStorage } from '../storage/local.ts';
import { ScriptedDecisionError } from './decisions.ts';
import { InputRejectedError } from './ingest.ts';
import { ProjectDirError } from './project.ts';
import { DemoSeedError, seedDemoRun } from './seed.ts';

// `npm run demo:seed -- [project-dir]` (docs/architecture.md §11 and §13). Exit codes: 0 the demo
// run completed (its ID is printed); 1 the run did not meet the seed's guarantees; 2 invalid
// invocation, environment, or project input (nothing was run).

const USAGE = `Usage: npm run demo:seed -- [project-dir] [options]

Runs a fixture project (default: fixtures/projects/synthetic-walkthrough) through the real
pipeline in fixture mode, against DATABASE_URL and STORAGE_DIR, and prints the run ID to put in
DEMO_RUN_IDS. Zero model calls: every Meta request is answered from the project's cassette.
Needs the API's environment, applied migrations, and ffmpeg. Every listed run becomes public.

Options:
  --timeout-minutes <n>  give up after n minutes (default 30)
  --verbose              log at info level
  --help                 show this help`;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEFAULT_PROJECT = path.join(REPO_ROOT, 'fixtures', 'projects', 'synthetic-walkthrough');

const argsSchema = z.object({
  'timeout-minutes': z.coerce
    .number()
    .positive()
    .max(24 * 60)
    .default(30),
  verbose: z.boolean().default(false),
  help: z.boolean().default(false),
});

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'timeout-minutes': { type: 'string' },
        verbose: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`, 2);
  }
  const options = argsSchema.safeParse(parsed.values);
  if (!options.success) fail(`${z.prettifyError(options.error)}\n\n${USAGE}`, 2);
  if (options.data.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const [projectArg, ...extra] = parsed.positionals;
  if (extra.length > 0) fail(USAGE, 2);
  // npm runs scripts from the repository root; resolve paths against where it was invoked.
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  const projectDir = projectArg === undefined ? DEFAULT_PROJECT : path.resolve(cwd, projectArg);

  let env;
  try {
    env = loadEnv(process.env, 'demo-seed');
  } catch (error) {
    if (error instanceof EnvError) fail(error.message, 2);
    throw error;
  }
  const logger = createLogger({
    // Step failures already appear as progress lines; engine warnings would repeat them.
    LOG_LEVEL: options.data.verbose ? 'info' : 'error',
    NODE_ENV: env.NODE_ENV,
  });
  const dbClient = createDbClient(env.DATABASE_URL, { logger });
  try {
    const result = await seedDemoRun({
      projectDir,
      db: dbClient.db,
      connectionString: env.DATABASE_URL,
      storage: createLocalStorage({ rootDir: env.STORAGE_DIR }),
      dailyCapUsd: env.DAILY_BUDGET_USD,
      logger,
      progress: (line) => process.stderr.write(`${line}\n`),
      timeoutMs: options.data['timeout-minutes'] * 60_000,
      ...(env.DEFINITIONS_DIR === undefined ? {} : { definitionsDir: env.DEFINITIONS_DIR }),
    });
    process.stdout.write(
      [
        '',
        `Demo run completed: ${result.runId}`,
        `  project:   ${result.projectTitle} (cassette ${result.cassette})`,
        `  owner:     ${result.ownerCreated ? 'created' : 'reused'} (no login possible)`,
        `  calls:     ${result.calls} metered, ${result.servedFromCassette} from the cassette, ${result.liveRequests} live`,
        `  cost:      ${result.costUsd} USD as if live (nothing billed; not counted against DAILY_BUDGET_USD)`,
        '',
        'Publish it (this run becomes public without login):',
        `  DEMO_RUN_IDS=${result.runId}`,
        '',
      ].join('\n'),
    );
  } catch (error) {
    if (
      error instanceof ProjectDirError ||
      error instanceof InputRejectedError ||
      error instanceof DefinitionError
    ) {
      fail(error.message, 2);
    }
    if (error instanceof DemoSeedError || error instanceof ScriptedDecisionError) {
      fail(error.message, 1);
    }
    throw error;
  } finally {
    await dbClient.close();
  }
}

await main();
