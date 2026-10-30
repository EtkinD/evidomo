import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DefinitionError, loadDefinitions } from '../definitions/loader.ts';
import { createMetaClients, MetaConfigError } from '../meta/clients.ts';
import { createInMemoryUsageRecorder } from '../meta/usage.ts';
import { createPriceTableCostEstimator } from '../usage/ledger.ts';
import { assertNotProduction, ProductionRefusedError } from './dev-seed-run.ts';
import {
  generateShowcaseImages,
  planShowcaseImages,
  ShowcasePlanError,
  ShowcaseSpendUnknownError,
} from './showcase-images.ts';
import { SHOWCASE_DIRECTIONS, SHOWCASE_IMAGES } from './showcase-prompts.ts';

// Dev-only generator for the Phase 4b design showcase images (P4B-01). Makes LIVE, billed Muse
// Image calls with every built-in tool off. Exit codes: 0 every planned image exists; 1 some
// failed or were not attempted (budget); 2 invalid invocation or configuration, or production.

const USAGE = `Usage: node --env-file=<repo>/.env apps/api/src/cli/generate-showcase-images.ts \\
  --out <dir> --max-usd <amount> [options]

Generates the showcase prompt list (showcase-prompts.ts) with Muse Image, image search, web
search, and shell all off (POST /v1/images/generations), and writes <dir>/<A|B|C>/*.webp and
<dir>/manifest.json. LIVE and billed ($0.01 per image). Images already in the manifest with the
same prompt are kept; development only, refuses NODE_ENV=production.

Options:
  --out <dir>          output directory (required; the showcase reads
                       apps/web/public/showcase-assets, which is gitignored)
  --max-usd <amount>   spend cap for this invocation (required)
  --only <ids>         comma-separated IDs to regenerate (e.g. A-LOGO-2,C-HERO-1)
  --concurrency <n>    parallel calls (default 2)
  --dry-run            print the plan and the full prompts; no calls
  --help               show this help`;

const argsSchema = z.object({
  out: z.string().min(1).optional(),
  'max-usd': z.coerce.number().positive().max(5).optional(),
  only: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    )
    .optional(),
  concurrency: z.coerce.number().int().min(1).max(4).default(2),
  'dry-run': z.boolean().default(false),
  help: z.boolean().default(false),
});

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  try {
    assertNotProduction('generate-showcase-images', process.env['NODE_ENV']);
  } catch (error) {
    if (error instanceof ProductionRefusedError) fail(error.message, 2);
    throw error;
  }
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        out: { type: 'string' },
        'max-usd': { type: 'string' },
        only: { type: 'string' },
        concurrency: { type: 'string' },
        'dry-run': { type: 'boolean' },
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

  let plan;
  try {
    plan = planShowcaseImages(SHOWCASE_DIRECTIONS, SHOWCASE_IMAGES);
  } catch (error) {
    if (error instanceof ShowcasePlanError) fail(error.message, 2);
    throw error;
  }
  if (options.data['dry-run']) {
    for (const item of plan) {
      process.stdout.write(`${item.id}  ${item.file}  ${item.size}\n  ${item.prompt}\n\n`);
    }
    return;
  }

  const { out, 'max-usd': maxUsd } = options.data;
  if (out === undefined || maxUsd === undefined) {
    fail(`--out and --max-usd are required\n\n${USAGE}`, 2);
  }

  // The image model is the one the product stages with; the showcase has no step of its own.
  let modelId: string;
  try {
    const definitions = await loadDefinitions(process.env['DEFINITIONS_DIR'] || undefined);
    const models = new Set(
      definitions.services.flatMap((service) =>
        service.steps.flatMap((step) => (step.agent === 'stager' ? [step.image_model] : [])),
      ),
    );
    const [only, ...others] = models;
    if (only === undefined || others.length > 0) {
      fail(`Expected one stager image_model in the definitions, found ${String(models.size)}`, 2);
    }
    modelId = only;
  } catch (error) {
    if (error instanceof DefinitionError) fail(error.message, 2);
    throw error;
  }

  const estimateCost = createPriceTableCostEstimator();
  const usdPerImage = estimateCost({
    modelId,
    inputTokens: undefined,
    cachedInputTokens: undefined,
    outputTokens: undefined,
    reasoningTokens: undefined,
    totalTokens: undefined,
    images: 1,
  });
  if (usdPerImage === undefined) fail(`${modelId} has no per-image price in PRICE_TABLE`, 2);

  const usage = createInMemoryUsageRecorder();
  let clients;
  try {
    clients = createMetaClients({ apiKey: process.env['MODEL_API_KEY'], usage, estimateCost });
  } catch (error) {
    if (error instanceof MetaConfigError) fail(error.message, 2);
    throw error;
  }

  // npm runs scripts from the repository root; resolve paths against where it was invoked.
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  const outDir = path.resolve(cwd, out);
  process.stderr.write(`Model ${modelId}, ${String(plan.length)} planned images, into ${outDir}\n`);
  try {
    const result = await generateShowcaseImages({
      clients,
      usage,
      modelId,
      outDir,
      plan,
      ...(options.data.only === undefined ? {} : { only: new Set(options.data.only) }),
      maxUsd,
      usdPerImage,
      concurrency: options.data.concurrency,
      progress: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(
      [
        '',
        `generated:     ${String(result.generated.length)}`,
        `kept:          ${String(result.kept.length)}`,
        `failed:        ${String(result.failed.length)}${result.failed.map((f) => `\n  ${f.id}: ${f.error}`).join('')}`,
        `not attempted: ${String(result.notAttempted.length)}${result.notAttempted.length > 0 ? ` (budget): ${result.notAttempted.join(', ')}` : ''}`,
        `in manifest:   ${String(result.manifest.items.length)} of ${String(plan.length)}`,
        `spent:         ${result.spentUsd.toFixed(2)} USD (${String(usage.entries.length)} metered responses)`,
        '',
      ].join('\n'),
    );
    if (result.failed.length > 0 || result.notAttempted.length > 0) process.exitCode = 1;
  } catch (error) {
    if (error instanceof ShowcasePlanError || error instanceof ShowcaseSpendUnknownError) {
      fail(error.message, 2);
    }
    throw error;
  }
}

await main();
