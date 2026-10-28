import type { Logger } from '../logger.ts';
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
  { kind: 'market', id: 'nl', version: 1 },
];

function assertRequiredDefinitions(registry: DefinitionRegistry): void {
  const issues: DefinitionIssue[] = REQUIRED_DEFINITIONS.flatMap(({ kind, id, version }) => {
    const items = kind === 'service' ? registry.services : registry.markets;
    const present = items.some((item) => item.id === id && item.version === version);
    const file = `${kind === 'service' ? 'services' : 'markets'}/${id}.v${version}.yaml`;
    return present ? [] : [{ file, message: `Required ${kind} definition is missing` }];
  });
  if (issues.length > 0) throw new DefinitionError(registry.dir, issues);
}

export interface BootDefinitionsOptions {
  readonly dir?: string | undefined;
  readonly logger: Logger;
  /** Injected by tests; defaults to `process.exit`. */
  readonly exit?: (code: number) => never;
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
