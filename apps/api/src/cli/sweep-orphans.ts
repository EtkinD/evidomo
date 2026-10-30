import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createDbClient } from '../db/client.ts';
import { EnvError, loadEnv } from '../env.ts';
import { createLogger } from '../logger.ts';
import {
  DEFAULT_ORPHAN_MIN_AGE_MS,
  sweepOrphanedProjectFiles,
  type SweepResult,
} from '../projects/orphan-files.ts';
import { createLocalStorage } from '../storage/local.ts';

// `npm run storage:sweep -- [--delete] [--bind] [--min-age-hours <n>] [--limit <n>]`
// (docs/architecture.md §8 "Project deletion"). Exit codes: 0 done (or nothing to do); 1 the sweep was refused or a project's
// files could not be removed; 2 invalid invocation or environment (nothing was touched).

const USAGE = `Usage: npm run storage:sweep -- [options]

Lists the project directories in STORAGE_DIR whose project no longer exists in DATABASE_URL
(files left behind after a project deletion). Read-only unless --delete is given.

Options:
  --delete             remove the orphaned projects' files
  --bind               with --delete: record that STORAGE_DIR belongs to DATABASE_URL first,
                       replacing any earlier record; only after checking that the two really
                       belong together. Without it, --delete needs an existing matching record.
  --min-age-hours <n>  skip directories with anything modified in the last n hours (default 24;
                       0 removes regardless of age)
  --limit <n>          remove at most n projects (default: all)
  --help               show this help`;

const argsSchema = z.object({
  delete: z.boolean().default(false),
  bind: z.boolean().default(false),
  limit: z.coerce.number().int().positive().optional(),
  'min-age-hours': z.coerce
    .number()
    .min(0)
    .max(24 * 365)
    .default(DEFAULT_ORPHAN_MIN_AGE_MS / 3_600_000),
  help: z.boolean().default(false),
});

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function report(result: SweepResult): number {
  const { scan } = result;
  const lines = [
    `Project directories: ${scan.scannedCount} (${scan.ignoredCount} other names ignored)`,
    `Orphaned projects:   ${scan.orphanProjectIds.length}`,
  ];
  let code = 0;
  switch (result.status) {
    case 'dry_run':
      lines.push(...scan.orphanProjectIds.map((id) => `  ${id}`));
      lines.push(`Storage binding:     ${result.binding}`);
      if (scan.orphanProjectIds.length > 0) lines.push('Nothing deleted (pass --delete).');
      break;
    case 'refused':
      lines.push(
        result.reason === 'unbound'
          ? 'Refused: STORAGE_DIR is not bound to this database yet. Check the pairing, then pass --bind.'
          : 'Refused: STORAGE_DIR is bound to another database. Check the pairing, then pass --bind.',
      );
      code = 1;
      break;
    case 'swept':
      lines.push(`Removed:             ${result.removedProjectIds.length}`);
      lines.push(...result.removedProjectIds.map((id) => `  ${id}`));
      if (result.failedProjectIds.length > 0) {
        lines.push(`Failed:              ${result.failedProjectIds.length} (see the log)`);
        lines.push(...result.failedProjectIds.map((id) => `  ${id}`));
        code = 1;
      }
      if (result.tooRecentProjectIds.length > 0) {
        lines.push(
          `Too recent:          ${result.tooRecentProjectIds.length} (see --min-age-hours)`,
        );
        lines.push(...result.tooRecentProjectIds.map((id) => `  ${id}`));
      }
      if (result.deferredCount > 0) lines.push(`Left for later:      ${result.deferredCount}`);
      break;
    default: {
      const unreachable: never = result;
      throw new Error(`Unhandled sweep result ${JSON.stringify(unreachable)}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return code;
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        delete: { type: 'boolean' },
        bind: { type: 'boolean' },
        limit: { type: 'string' },
        'min-age-hours': { type: 'string' },
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
  if (options.data.bind && !options.data.delete) fail(`--bind needs --delete\n\n${USAGE}`, 2);

  let env;
  try {
    env = loadEnv(process.env, 'maintenance');
  } catch (error) {
    if (error instanceof EnvError) fail(error.message, 2);
    throw error;
  }
  const logger = createLogger({ LOG_LEVEL: env.LOG_LEVEL, NODE_ENV: env.NODE_ENV });
  const dbClient = createDbClient(env.DATABASE_URL, { logger });
  try {
    const result = await sweepOrphanedProjectFiles(
      { db: dbClient.db, storage: createLocalStorage({ rootDir: env.STORAGE_DIR }), logger },
      {
        limit: options.data.limit ?? Number.MAX_SAFE_INTEGER,
        bind: options.data.bind,
        minAgeMs: options.data['min-age-hours'] * 3_600_000,
        dryRun: !options.data.delete,
      },
    );
    process.exitCode = report(result);
  } finally {
    await dbClient.close();
  }
}

await main();
