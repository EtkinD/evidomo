import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DefinitionError } from '../definitions/loader.ts';
import { createLogger } from '../logger.ts';
import { ScriptedDecisionError } from './decisions.ts';
import { InputRejectedError } from './ingest.ts';
import { ProjectDirError } from './project.ts';
import { RecordedPathsError } from './recorded-paths.ts';
import { listRecordedPaths, PipelineUsageError, runPipeline } from './run.ts';
import { formatSummary } from './summary.ts';

// `npm run pipeline -- <project-dir> [options]` (docs/architecture.md §5 "Headless pipeline CLI").
// Exit codes: 0 the run completed; 1 the run failed or stopped at a gate; 2 invalid invocation
// or project input (nothing was run).

const USAGE = `Usage: npm run pipeline -- <project-dir> [options]

Runs a project directory through the real pipeline (run engine, step handlers, gate services)
on a throwaway PostgreSQL (Testcontainers; Docker must be running) with scripted gate decisions.

Options:
  --mode <fixtures|live|record>  fixtures (default): replay the project's recorded run, no network;
                                 live: call the Meta API (MODEL_API_KEY, spends credit);
                                 record: live through the recorder, writing the cassette
  --out <dir>                    where the export goes (default: data/pipeline/<project-name>)
  --force                        overwrite an earlier export in --out
  --voice-memo <file>            use this voice memo instead of the project's
  --decisions <file>             use this decisions file instead of <project-dir>/decisions.json
  --cassette <name>              use this cassette instead of the project's "fixture"
  --gate1-path <id>              decide Gate 1 as this recorded-paths ID (e.g. 2-x-1) instead of
                                 the decisions file; record mode then records that path
  --list-paths                   print every Gate 1 path of the cassette, recorded or missing,
                                 in recording order, and exit (runs nothing)
  --timeout-minutes <n>          give up after n minutes (default 30)
  --verbose                      log at info level
  --help                         show this help`;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const argsSchema = z.object({
  mode: z.enum(['fixtures', 'live', 'record']).default('fixtures'),
  out: z.string().min(1).optional(),
  force: z.boolean().default(false),
  'voice-memo': z.string().min(1).optional(),
  decisions: z.string().min(1).optional(),
  cassette: z.string().min(1).optional(),
  'gate1-path': z.string().min(1).max(200).optional(),
  'list-paths': z.boolean().default(false),
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
        mode: { type: 'string' },
        out: { type: 'string' },
        force: { type: 'boolean' },
        'voice-memo': { type: 'string' },
        decisions: { type: 'string' },
        cassette: { type: 'string' },
        'gate1-path': { type: 'string' },
        'list-paths': { type: 'boolean' },
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
  if (projectArg === undefined || extra.length > 0) fail(USAGE, 2);

  // npm runs scripts from the repository root; resolve paths against where it was invoked.
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  const resolve = (file: string): string => path.resolve(cwd, file);
  const projectDir = resolve(projectArg);
  const args = options.data;
  const outDir =
    args.out === undefined
      ? path.join(REPO_ROOT, 'data', 'pipeline', path.basename(projectDir))
      : resolve(args.out);

  const logger = createLogger({
    // Step failures already appear as progress lines; engine warnings would repeat them.
    LOG_LEVEL: args.verbose ? 'info' : 'error',
    NODE_ENV: 'development',
  });
  try {
    if (args['list-paths']) {
      process.stdout.write(
        `${(await listRecordedPaths(projectDir, args.cassette, args.decisions === undefined ? undefined : resolve(args.decisions))).join('\n')}\n`,
      );
      return;
    }
    const summary = await runPipeline({
      projectDir,
      mode: args.mode,
      outDir,
      force: args.force,
      ...(args['voice-memo'] === undefined ? {} : { voiceMemo: resolve(args['voice-memo']) }),
      ...(args.decisions === undefined ? {} : { decisionsPath: resolve(args.decisions) }),
      ...(args.cassette === undefined ? {} : { cassette: args.cassette }),
      ...(args['gate1-path'] === undefined ? {} : { gate1Path: args['gate1-path'] }),
      env: process.env,
      logger,
      timeoutMs: args['timeout-minutes'] * 60_000,
      progress: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`\n${formatSummary(summary)}\n`);
    const clean =
      summary.status === 'completed' &&
      (summary.network === null || summary.network.unmatched.length === 0);
    process.exitCode = clean ? 0 : 1;
  } catch (error) {
    if (
      error instanceof ProjectDirError ||
      error instanceof PipelineUsageError ||
      error instanceof InputRejectedError ||
      error instanceof DefinitionError ||
      error instanceof RecordedPathsError
    ) {
      fail(error.message, 2);
    }
    if (error instanceof ScriptedDecisionError) fail(error.message, 1);
    throw error;
  }
}

await main();
