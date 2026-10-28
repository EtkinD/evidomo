import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  marketProfileFileSchema,
  serviceDefinitionFileSchema,
  type MarketProfile,
  type ServiceDefinition,
} from '@evidomo/shared';
import { isMap, isNode, isPair, isScalar, LineCounter, parseDocument, visit } from 'yaml';
import type { Document, DocumentOptions, ParseOptions, SchemaOptions } from 'yaml';
import type { z } from 'zod';

/**
 * `<repo>/definitions`, resolved from this module's location so it works from any working
 * directory and in the Docker image (`/app/apps/api/src/definitions` → `/app/definitions`).
 */
export const DEFAULT_DEFINITIONS_DIR = fileURLToPath(
  new URL('../../../../definitions/', import.meta.url),
);

export const DEFINITION_KINDS = ['service', 'market'] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

const KIND_DIRS: Readonly<Record<DefinitionKind, string>> = {
  service: 'services',
  market: 'markets',
};

// `<id>.v<version>.yaml`; the ID and version must match the file's content.
const FILE_NAME_PATTERN = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.v([1-9][0-9]*)\.yaml$/;

/** One problem in one definition file, located as precisely as the YAML allows. */
export interface DefinitionIssue {
  /** Path relative to the definitions directory, e.g. `markets/nl.v1.yaml`. */
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  /** Path inside the document, e.g. `market.facts[1].basis`. */
  readonly path?: string;
  readonly message: string;
}

export function formatDefinitionIssue(issue: DefinitionIssue): string {
  const location =
    issue.line === undefined ? issue.file : `${issue.file}:${issue.line}:${issue.column ?? 1}`;
  return issue.path === undefined
    ? `${location}: ${issue.message}`
    : `${location}: ${issue.path}: ${issue.message}`;
}

/** Thrown when definitions cannot be loaded; lists every problem found, not just the first. */
export class DefinitionError extends Error {
  override name = 'DefinitionError';
  readonly dir: string;
  readonly issues: readonly DefinitionIssue[];

  constructor(dir: string, issues: readonly DefinitionIssue[]) {
    const count = issues.length === 1 ? '1 problem' : `${issues.length} problems`;
    super(
      `Invalid definitions in ${dir} (${count}):\n${issues
        .map((issue) => `  - ${formatDefinitionIssue(issue)}`)
        .join('\n')}`,
    );
    this.dir = dir;
    this.issues = issues;
  }
}

export class DefinitionNotFoundError extends Error {
  override name = 'DefinitionNotFoundError';
}

export interface DefinitionRegistry {
  readonly dir: string;
  readonly services: readonly ServiceDefinition[];
  readonly markets: readonly MarketProfile[];
  /** Runs record the ID and version they used, so lookups are always by both. */
  getService(id: string, version: number): ServiceDefinition;
  getMarket(id: string, version: number): MarketProfile;
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly DefinitionIssue[] };

// YAML 1.2 core schema only: no custom or `!!` tags beyond the core set, no merge keys, unique
// keys. Warnings (e.g. an unresolved tag) are treated as errors below.
const YAML_OPTIONS: Readonly<ParseOptions & DocumentOptions & SchemaOptions> = {
  version: '1.2',
  schema: 'core',
  strict: true,
  uniqueKeys: true,
  merge: false,
  customTags: [],
  resolveKnownTags: false,
  prettyErrors: false,
};

function formatZodPath(segments: readonly PropertyKey[]): string {
  let result = '';
  for (const segment of segments) {
    if (typeof segment === 'number') result += `[${segment}]`;
    else result += result === '' ? String(segment) : `.${String(segment)}`;
  }
  return result;
}

/** The source offset of the deepest existing node on `segments`, for line/column reporting. */
function offsetOf(doc: Document, segments: readonly PropertyKey[], unknownKey?: string): number {
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const node = doc.getIn(segments.slice(0, depth), true);
    if (!isNode(node)) continue;
    // Point an unknown-key issue at the key itself rather than at the enclosing object.
    if (depth === segments.length && unknownKey !== undefined && isMap(node)) {
      const pair = node.items.find(
        (item) => isPair(item) && isScalar(item.key) && item.key.value === unknownKey,
      );
      if (pair !== undefined && isScalar(pair.key) && pair.key.range) return pair.key.range[0];
    }
    if (node.range) return node.range[0];
  }
  return 0;
}

function parseDefinitionYaml<T>(
  source: string,
  file: string,
  schema: z.ZodType<T>,
): ParseResult<T> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { ...YAML_OPTIONS, lineCounter });
  const located = (offset: number, message: string, docPath?: string): DefinitionIssue => {
    const { line, col } = lineCounter.linePos(offset);
    return docPath === undefined
      ? { file, line, column: col, message }
      : { file, line, column: col, path: docPath, message };
  };

  const yamlProblems = [...doc.errors, ...doc.warnings].map((problem) =>
    located(problem.pos[0], `Invalid YAML (${problem.code}): ${problem.message}`),
  );
  if (yamlProblems.length > 0) return { ok: false, issues: yamlProblems };

  // Aliases are refused so every value is written out where it applies and reviewable in place.
  const aliasIssues: DefinitionIssue[] = [];
  visit(doc, {
    Alias(_key, node) {
      aliasIssues.push(
        located(node.range?.[0] ?? 0, 'YAML aliases (*name) are not allowed in definitions'),
      );
    },
  });
  if (aliasIssues.length > 0) return { ok: false, issues: aliasIssues };

  const result = schema.safeParse(doc.toJS());
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const unknownKey = issue.code === 'unrecognized_keys' ? issue.keys[0] : undefined;
      const docPath = formatZodPath(issue.path);
      // zod reports a missing key as an invalid value of `undefined` ("Invalid option: ...");
      // say plainly that the key is absent and keep zod's description of what it expects.
      const lastSegment = issue.path.at(-1);
      const missing =
        issue.code !== 'custom' && typeof lastSegment === 'string' && !doc.hasIn(issue.path);
      const message = missing
        ? `Missing required key "${lastSegment}" (${issue.message})`
        : issue.message;
      return located(
        offsetOf(doc, issue.path, unknownKey),
        message,
        docPath === '' ? undefined : docPath,
      );
    }),
  };
}

function checkFileName(
  file: string,
  fileName: string,
  kind: DefinitionKind,
  content: { readonly id: string; readonly version: number },
): DefinitionIssue[] {
  const expected = `${content.id}.v${content.version}.yaml`;
  return fileName === expected
    ? []
    : [
        {
          file,
          path: `${kind}.id`,
          message: `File name must match the ${kind} ID and version: expected "${expected}"`,
        },
      ];
}

/** Parses one service definition file's source. `file` is used in issue locations. */
export function parseServiceDefinition(
  source: string,
  file: string,
): ParseResult<ServiceDefinition> {
  const parsed = parseDefinitionYaml(source, file, serviceDefinitionFileSchema);
  return parsed.ok ? { ok: true, value: parsed.value.service } : parsed;
}

/** Parses one market profile file's source. `file` is used in issue locations. */
export function parseMarketProfile(source: string, file: string): ParseResult<MarketProfile> {
  const parsed = parseDefinitionYaml(source, file, marketProfileFileSchema);
  return parsed.ok ? { ok: true, value: parsed.value.market } : parsed;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadKind<T extends { readonly id: string; readonly version: number }>(
  dir: string,
  kind: DefinitionKind,
  parse: (source: string, file: string) => ParseResult<T>,
  issues: DefinitionIssue[],
): Promise<T[]> {
  const kindDir = KIND_DIRS[kind];
  let entries;
  try {
    entries = await readdir(path.join(dir, kindDir), { withFileTypes: true });
  } catch (error) {
    issues.push({ file: kindDir, message: `Cannot read directory: ${errorMessage(error)}` });
    return [];
  }

  const loaded: T[] = [];
  const names = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of names) {
    const file = `${kindDir}/${entry.name}`;
    // Anything else in the directory is refused rather than skipped, so a misnamed file
    // (`nl.v2.yml`) cannot silently go unloaded.
    if (!entry.isFile() || !FILE_NAME_PATTERN.test(entry.name)) {
      issues.push({ file, message: 'Expected a file named <id>.v<version>.yaml' });
      continue;
    }
    let source: string;
    try {
      source = await readFile(path.join(dir, file), 'utf8');
    } catch (error) {
      issues.push({ file, message: `Cannot read file: ${errorMessage(error)}` });
      continue;
    }
    const parsed = parse(source, file);
    if (!parsed.ok) {
      issues.push(...parsed.issues);
      continue;
    }
    const nameIssues = checkFileName(file, entry.name, kind, parsed.value);
    if (nameIssues.length > 0) {
      issues.push(...nameIssues);
      continue;
    }
    loaded.push(deepFreeze(parsed.value));
  }
  if (loaded.length === 0 && !issues.some((issue) => issue.file.startsWith(`${kindDir}/`))) {
    issues.push({ file: kindDir, message: `No ${kind} definitions found` });
  }
  return loaded;
}

function lookup<T extends { readonly id: string; readonly version: number }>(
  items: readonly T[],
  kind: DefinitionKind,
  id: string,
  version: number,
): T {
  const found = items.find((item) => item.id === id && item.version === version);
  if (found === undefined) {
    throw new DefinitionNotFoundError(`No ${kind} definition "${id}" version ${version}`);
  }
  return found;
}

/**
 * Loads and validates every service definition and market profile under `dir`
 * (`services/*.yaml`, `markets/*.yaml`). Throws a {@link DefinitionError} listing all problems,
 * so a broken definition stops the process at boot instead of failing a run later.
 */
export async function loadDefinitions(
  dir: string = DEFAULT_DEFINITIONS_DIR,
): Promise<DefinitionRegistry> {
  const root = path.resolve(dir);
  const issues: DefinitionIssue[] = [];
  const services = await loadKind(root, 'service', parseServiceDefinition, issues);
  const markets = await loadKind(root, 'market', parseMarketProfile, issues);
  if (issues.length > 0) throw new DefinitionError(root, issues);

  return Object.freeze({
    dir: root,
    services: Object.freeze(services),
    markets: Object.freeze(markets),
    getService: (id: string, version: number) => lookup(services, 'service', id, version),
    getMarket: (id: string, version: number) => lookup(markets, 'market', id, version),
  });
}
