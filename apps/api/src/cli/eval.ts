import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DefinitionError } from '../definitions/loader.ts';
import { evalReportMarkdown, formatEvalReport } from '../eval/report.ts';
import { EVAL_MODES, EvalUsageError, runEval } from '../eval/run.ts';
import { EvalSetError } from '../eval/sets.ts';
import { createLogger } from '../logger.ts';
import { ProjectDirError } from './project.ts';

// `npm run eval -- [options]` (docs/architecture.md §12 "Seeded-defect eval"). Exit codes: 0
// every set ran to the end; 1 a set failed, stopped early, or (fixtures) a request had no
// recording; 2 invalid invocation or set (nothing ran). Catch rates never change the exit code:
// the eval measures, it does not gate.

const USAGE = `Usage: npm run eval -- [options]

Runs the seeded property sets in fixtures/eval/ through the real pipeline on a throwaway
PostgreSQL (Testcontainers; Docker must be running) and scores them against their answer keys.

Options:
  --mode <fixtures|record|live>  fixtures (default): replay the committed cassettes, no network;
                                 record: live through the recorder into the sets' cassettes,
                                 paying only for requests they do not answer yet;
                                 live: every request live (MODEL_API_KEY, spends credit) except
                                 the walkthrough transcription (see --voice-memo)
  --sets <id,id,...>             run only these sets (default: all)
  --max-usd <amount>             record/live: stop before a set could take the live spend past
                                 this (default 2.00)
  --out <dir>                    report directory (default: data/eval/<mode>-<time>)
  --voice-memo <file>            live/record: transcribe this walkthrough live instead
  --timeout-minutes <n>          give up on a set after n minutes (default 30)
  --verbose                      log at info level
  --help                         show this help`;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const argsSchema = z.object({
  mode: z.enum(EVAL_MODES).default('fixtures'),
  sets: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? []
        : value
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id !== ''),
    ),
  'max-usd': z.string().default('2.00'),
  out: z.string().min(1).optional(),
  'voice-memo': z.string().min(1).optional(),
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
      allowPositionals: false,
      options: {
        mode: { type: 'string' },
        sets: { type: 'string' },
        'max-usd': { type: 'string' },
        out: { type: 'string' },
        'voice-memo': { type: 'string' },
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
  const args = options.data;
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.mode === 'fixtures' && args['voice-memo'] !== undefined) {
    fail('--voice-memo needs --mode record or live (fixtures replay the recorded transcript)', 2);
  }
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  const resolve = (file: string): string => path.resolve(cwd, file);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const outDir =
    args.out === undefined
      ? path.join(REPO_ROOT, 'data', 'eval', `${args.mode}-${stamp}`)
      : resolve(args.out);
  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length > 0) fail(`Output directory ${outDir} is not empty`, 2);

  const logger = createLogger({
    LOG_LEVEL: args.verbose ? 'info' : 'error',
    NODE_ENV: 'development',
  });
  try {
    const report = await runEval({
      mode: args.mode,
      sets: args.sets,
      maxUsd: args['max-usd'],
      outDir,
      ...(args['voice-memo'] === undefined ? {} : { voiceMemo: resolve(args['voice-memo']) }),
      env: process.env,
      logger,
      timeoutMs: args['timeout-minutes'] * 60_000,
      progress: (line) => process.stderr.write(`${line}\n`),
    });
    await writeFile(
      path.join(outDir, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    await writeFile(path.join(outDir, 'report.md'), evalReportMarkdown(report), 'utf8');
    process.stdout.write(`\n${formatEvalReport(report)}\n\nReport: ${outDir}\n`);
    const clean =
      report.skippedForBudget.length === 0 &&
      report.sets.every((s) => s.status === 'completed' && s.network.unmatched.length === 0);
    process.exitCode = clean ? 0 : 1;
  } catch (error) {
    if (
      error instanceof EvalUsageError ||
      error instanceof EvalSetError ||
      error instanceof ProjectDirError ||
      error instanceof DefinitionError
    ) {
      fail(error.message, 2);
    }
    throw error;
  }
}

await main();
