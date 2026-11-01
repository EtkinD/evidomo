import { hasPackStrings } from '../export/strings.ts';
import type { Logger } from '../logger.ts';
import { CLAIM_LANGUAGES } from '../pipeline/claims/numbers.ts';
import {
  DefinitionError,
  loadDefinitions,
  type DefinitionIssue,
  type DefinitionKind,
  type DefinitionRegistry,
} from './loader.ts';

/**
 * Definitions the product depends on. Projects and runs reference them by ID and version, so a
 * published version must never disappear from the image; boot fails if one is missing.
 */
export const REQUIRED_DEFINITIONS: readonly {
  readonly kind: DefinitionKind;
  readonly id: string;
  readonly version: number;
}[] = [
  { kind: 'service', id: 'listing-launch', version: 1 },
  { kind: 'market', id: 'international', version: 1 },
  { kind: 'market', id: 'international', version: 2 },
  { kind: 'market', id: 'nl', version: 1 },
  { kind: 'market', id: 'nl', version: 2 },
];

/**
 * Output languages the pipeline can produce end to end. A language needs claim validator rules
 * (copy whose numbers cannot be checked is never generated) and the HTML pack's fixed wording
 * (`export/strings.ts`, which would otherwise fall back to English); boot refuses a market profile
 * that offers any other, so the gap shows at deploy instead of in a paid run.
 */
export const SUPPORTED_OUTPUT_LANGUAGES: readonly string[] = CLAIM_LANGUAGES.filter((language) =>
  hasPackStrings(language),
);

function assertRequiredDefinitions(registry: DefinitionRegistry): void {
  const issues: DefinitionIssue[] = REQUIRED_DEFINITIONS.flatMap(({ kind, id, version }) => {
    const items = kind === 'service' ? registry.services : registry.markets;
    const present = items.some((item) => item.id === id && item.version === version);
    const file = `${kind === 'service' ? 'services' : 'markets'}/${id}.v${version}.yaml`;
    return present ? [] : [{ file, message: `Required ${kind} definition is missing` }];
  });
  if (issues.length > 0) throw new DefinitionError(registry.dir, issues);
}

/** Fails when a loaded market profile offers an output language outside `supported`. */
export function assertOutputLanguages(
  registry: Pick<DefinitionRegistry, 'dir' | 'markets'>,
  supported: readonly string[],
): void {
  const issues: DefinitionIssue[] = registry.markets.flatMap((market) =>
    market.output_languages
      .filter((language) => !supported.includes(language))
      .map((language) => ({
        file: `markets/${market.id}.v${market.version}.yaml`,
        path: 'market.output_languages',
        message: `Output language "${language}" is not supported by the pipeline (supported: ${supported.join(', ')})`,
      })),
  );
  if (issues.length > 0) throw new DefinitionError(registry.dir, issues);
}

export interface BootDefinitionsOptions {
  readonly dir?: string | undefined;
  readonly logger: Logger;
  /** Injected by tests; defaults to `process.exit`. */
  readonly exit?: (code: number) => never;
  /** Injected by tests; defaults to {@link SUPPORTED_OUTPUT_LANGUAGES}. */
  readonly outputLanguages?: readonly string[];
}

/**
 * Loads and validates definitions for api/worker boot. On any problem it logs the full,
 * file-and-path-located error and exits with code 1 before the process opens a port, a pool,
 * or a queue.
 */
export async function bootDefinitions(
  options: BootDefinitionsOptions,
): Promise<DefinitionRegistry> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  try {
    const registry = await loadDefinitions(options.dir);
    assertRequiredDefinitions(registry);
    assertOutputLanguages(registry, options.outputLanguages ?? SUPPORTED_OUTPUT_LANGUAGES);
    options.logger.info(
      {
        dir: registry.dir,
        services: registry.services.map((s) => `${s.id}@${s.version}`),
        markets: registry.markets.map((m) => `${m.id}@${m.version}`),
      },
      'definitions loaded',
    );
    return registry;
  } catch (error) {
    const message = error instanceof DefinitionError ? error.message : 'Cannot load definitions';
    options.logger.fatal({ err: error }, message);
    return exit(1);
  }
}
