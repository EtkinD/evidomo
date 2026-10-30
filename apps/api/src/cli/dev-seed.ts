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
import {
  assertNotProduction,
  DEV_STOP_POINTS,
  DevSeedError,
  OwnerNotFoundError,
  ProductionRefusedError,
  seedDevRun,
  type DevSeedResult,
} from './dev-seed-run.ts';
import { formatRecordedPaths, RecordedPathsError } from './recorded-paths.ts';
import { InputRejectedError } from './ingest.ts';
import { ProjectDirError } from './project.ts';

// `npm run dev:seed -- --owner <email> [--stop-at gate1|gate2|completed] [--path <id>] [project-dir]`
// (docs/architecture.md §5 "Development seed"). Exit codes: 0 the run was seeded (IDs and URLs
// are printed); 1 the run did not end where asked; 2 invalid invocation, environment, account,
// or project input, or production (nothing was run).

const USAGE = `Usage: npm run dev:seed -- --owner <email> [options] [project-dir]

Puts a fixture project (default: fixtures/projects/synthetic-walkthrough) through the real
pipeline in fixture mode for an existing local account, against DATABASE_URL and STORAGE_DIR,
and leaves the run at a chosen point. Zero model calls: every Meta request is answered from the
project's cassette (under the project's "fixtureDir", default fixtures/meta/). Development only; refuses NODE_ENV=production. Needs migrations, ffmpeg, and
an account registered in the web app (the seed creates none and never touches passwords).

Options:
  --owner <email>        the account that owns the project and run (required)
  --stop-at <point>      gate1: waiting at Gate 1, every conflict open
                         gate2: Gate 1 decided as scripted, waiting at Gate 2
                         completed: both gates decided as scripted, exported (default)
  --path <id>            gate2/completed: decide Gate 1 as this recorded path (e.g. 2-x-1)
                         instead of the default one; "--stop-at gate1" lists them
  --timeout-minutes <n>  give up after n minutes (default 30)
  --verbose              log at info level
  --help                 show this help

To continue a seeded run from the web app with zero model calls, run
"npm run dev:worker:replay" instead of "npm run dev:worker".`;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DEFAULT_PROJECT = path.join(REPO_ROOT, 'fixtures', 'projects', 'synthetic-walkthrough');

const argsSchema = z.object({
  owner: z.string().trim().min(3).max(320).optional(),
  'stop-at': z.enum(DEV_STOP_POINTS).default('completed'),
  path: z.string().trim().min(1).max(200).optional(),
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

function stateLine(result: DevSeedResult): string {
  switch (result.stopAt) {
    case 'gate1':
      return `awaiting_gate at fact_conflicts (${result.stopped?.gate === 'fact_conflicts' ? result.stopped.conflictCount : '?'} conflicts open)`;
    case 'gate2':
      return result.stopped?.gate === 'claim_audit'
        ? `awaiting_gate at claim_audit (${result.stopped.openClaims} claims and ${result.stopped.openImages} images open)`
        : 'awaiting_gate at claim_audit';
    case 'completed':
      return 'completed (export ready)';
    default: {
      const unreachable: never = result.stopAt;
      throw new Error(`Unhandled stop point ${String(unreachable)}`);
    }
  }
}

function urlLines(result: DevSeedResult, origin: string): string[] {
  const run = `${origin}/runs/${result.runId}`;
  switch (result.stopAt) {
    case 'gate1':
      return [`  run monitor: ${run}`, `  Gate 1:      ${run}/conflicts`];
    case 'gate2':
      return [`  run monitor: ${run}`, `  Gate 2:      ${run}/review`];
    case 'completed':
      return [
        `  run monitor: ${run}`,
        `  pack viewer: ${run}/pack`,
        `  Gate 1:      ${run}/conflicts (decided)`,
        `  Gate 2:      ${run}/review (approved)`,
      ];
    default: {
      const unreachable: never = result.stopAt;
      throw new Error(`Unhandled stop point ${String(unreachable)}`);
    }
  }
}

function report(result: DevSeedResult, origin: string): string {
  const lines = [
    '',
    `Seeded run ${result.runId}`,
    `  project:   ${result.projectId} (${result.projectTitle})`,
    `  owner:     ${result.ownerEmail}`,
    `  state:     ${stateLine(result)}`,
    ...(result.path === null ? [] : [`  gate 1:    decided as recorded path ${result.path}`]),
    `  calls:     ${result.calls} metered, ${result.servedFromCassette} from the cassette, ${result.liveRequests} live`,
    `  cost:      ${result.costUsd} USD as if live (nothing billed)`,
    '',
    'Open (the web app must be running; sign in as the owner):',
    ...urlLines(result, origin),
  ];
  const stopped = result.stopped;
  if (stopped?.gate === 'fact_conflicts' && result.recordedPaths !== null) {
    lines.push(
      '',
      'To continue from the web app with zero model calls, run',
      `  npm run dev:worker:replay${result.projectDir === DEFAULT_PROJECT ? '' : ` -- ${result.projectDir}`}`,
      '(not dev:worker) and decide Gate 1 as one of the recorded paths below. A path ID gives',
      'one choice per conflict, in order: the side number to accept, or x to reject every side.',
      'Any other combination (or an edit) has no recording: the next step fails at once with',
      '"Development replay has no recording ...", still with zero live calls.',
      '',
      ...formatRecordedPaths(result.recordedPaths),
    );
  } else if (stopped?.gate === 'fact_conflicts') {
    lines.push(
      '',
      'To continue from the web app with zero model calls, run "npm run dev:worker:replay"',
      '(not dev:worker) and decide Gate 1 exactly like this; any other decision changes the',
      'later requests, which the cassette does not hold, and the run fails:',
      ...(stopped.scriptedDecisions === null
        ? [`  (the project's script cannot decide every conflict: ${stopped.conflicts.join(', ')})`]
        : stopped.scriptedDecisions.map((line) => `  ${line}`)),
    );
  } else if (stopped?.gate === 'claim_audit') {
    lines.push(
      '',
      'Gate 2 decisions are free: the only step after it is the export, which calls no model.',
      'Run "npm run dev:worker:replay" so the export runs with the replay worker.',
    );
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  // Before anything else, including argument and environment parsing.
  try {
    assertNotProduction('dev:seed', process.env['NODE_ENV']);
  } catch (error) {
    if (error instanceof ProductionRefusedError) fail(error.message, 2);
    throw error;
  }
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        owner: { type: 'string' },
        'stop-at': { type: 'string' },
        path: { type: 'string' },
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
  const ownerEmail = options.data.owner;
  if (ownerEmail === undefined) fail(`--owner <email> is required\n\n${USAGE}`, 2);
  const [projectArg, ...extra] = parsed.positionals;
  if (extra.length > 0) fail(USAGE, 2);
  // npm runs scripts from the repository root; resolve paths against where it was invoked.
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  const projectDir = projectArg === undefined ? DEFAULT_PROJECT : path.resolve(cwd, projectArg);

  let env;
  try {
    env = loadEnv(process.env);
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
    const result = await seedDevRun({
      projectDir,
      ownerEmail,
      stopAt: options.data['stop-at'],
      ...(options.data.path === undefined ? {} : { path: options.data.path }),
      db: dbClient.db,
      connectionString: env.DATABASE_URL,
      storage: createLocalStorage({ rootDir: env.STORAGE_DIR }),
      logger,
      progress: (line) => process.stderr.write(`${line}\n`),
      nodeEnv: env.NODE_ENV,
      timeoutMs: options.data['timeout-minutes'] * 60_000,
      ...(env.DEFINITIONS_DIR === undefined ? {} : { definitionsDir: env.DEFINITIONS_DIR }),
    });
    process.stdout.write(report(result, env.APP_ORIGIN));
  } catch (error) {
    if (
      error instanceof OwnerNotFoundError ||
      error instanceof ProductionRefusedError ||
      error instanceof ProjectDirError ||
      error instanceof InputRejectedError ||
      error instanceof DefinitionError ||
      error instanceof RecordedPathsError
    ) {
      fail(error.message, 2);
    }
    if (error instanceof DevSeedError || error instanceof ScriptedDecisionError) {
      fail(error.message, 1);
    }
    throw error;
  } finally {
    await dbClient.close();
  }
}

await main();
