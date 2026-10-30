import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  jsonObjectSchema,
  officeProfileSchema,
  type JsonObject,
  type MarketProfile,
  type OfficeProfile,
  type ServiceDefinition,
} from '@evidomo/shared';
import { z } from 'zod';
import type { DefinitionRegistry } from '../definitions/loader.ts';
import { cassettePath, META_FIXTURES_DIR } from '../meta/fixtures.ts';
import { FactFormError, factFormToCandidates } from '../pipeline/extraction/form.ts';
import { decisionsFileSchema, type DecisionsFile } from './decisions.ts';

// A pipeline project directory (docs/architecture.md §5, "Headless pipeline CLI"):
//
//   <dir>/project.json    title, service, market, language, office profile, fact form, inputs
//   <dir>/decisions.json  scripted Gate 1 and Gate 2 decisions (./decisions.ts)
//
// Input paths are relative to the directory and may point outside it (shared sample photos).

export const PROJECT_FILE = 'project.json';
export const DECISIONS_FILE = 'decisions.json';
export const PROJECT_FORMAT_VERSION = 1;

const relativePath = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !path.isAbsolute(value), 'must be relative to the project directory');

const definitionRef = z.strictObject({ id: z.string().min(1), version: z.int().positive() });

export const projectFileSchema = z.strictObject({
  formatVersion: z.literal(PROJECT_FORMAT_VERSION),
  title: z.string().trim().min(1).max(200),
  service: definitionRef,
  market: definitionRef,
  /** Defaults to the market's `default_output_language`. */
  outputLanguage: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  officeProfile: z.strictObject(officeProfileSchema.shape),
  /** The fact form exactly as intake expects it: market fact keys plus free-text fields. */
  factForm: jsonObjectSchema,
  /** Photos in upload order. File names must be unique: image decisions address them. */
  photos: z.array(relativePath).min(1).max(100),
  /** The voice walkthrough (any accepted audio format), or null when the service allows none. */
  voiceMemo: relativePath.nullable(),
  /**
   * Directory holding `fixture`, relative to the project directory; may point outside the
   * repository (recordings of raw samples must never be committed). Default: `fixtures/meta/`.
   */
  fixtureDir: relativePath.optional(),
  /** Cassette of a recorded run under `fixtureDir`, required by `--mode fixtures`. */
  fixture: z
    .string()
    .nullable()
    .refine((name) => {
      if (name === null) return true;
      try {
        cassettePath(name);
        return true;
      } catch {
        return false;
      }
    }, 'must be a cassette name such as "p3-10/synthetic-walkthrough"'),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

export interface ProjectPhoto {
  /** Unique file name, used to address image decisions. */
  readonly name: string;
  readonly path: string;
}

export interface Project {
  readonly dir: string;
  readonly title: string;
  readonly service: ServiceDefinition;
  readonly market: MarketProfile;
  readonly outputLanguage: string;
  readonly officeProfile: OfficeProfile;
  readonly factForm: JsonObject;
  readonly photos: readonly ProjectPhoto[];
  readonly voiceMemoPath: string | null;
  readonly fixture: string | null;
  /** Absolute directory of `fixture`: `fixtureDir` resolved, or the repository's `fixtures/meta`. */
  readonly fixturesDir: string;
  readonly decisions: DecisionsFile;
}

/** Everything wrong with a project directory, one problem per line. */
export class ProjectDirError extends Error {
  override name = 'ProjectDirError';
  readonly problems: readonly string[];

  constructor(dir: string, problems: readonly string[]) {
    super(`Invalid pipeline project ${dir}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

async function readJson(file: string, problems: string[]): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    problems.push(`${path.basename(file)}: ${missing ? 'file is missing' : 'cannot be read'}`);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    problems.push(`${path.basename(file)}: not valid JSON`);
    return undefined;
  }
}

function zodProblems(file: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length === 0 ? '' : ` ${issue.path.map(String).join('.')}:`;
    return `${file}:${where} ${issue.message}`;
  });
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Loads `project.json` and `decisions.json`, and checks them against the definitions before any
 * database, upload, or model call: the service and market exist, the language is offered, the
 * fact form fits the market profile, the inputs fit the service's input constraints, every file
 * exists, and every image decision names a project photo. `resolveService` returns the
 * definition the run will use.
 */
export async function loadProject(
  dir: string,
  registry: Pick<DefinitionRegistry, 'getMarket'>,
  resolveService: (id: string, version: number) => ServiceDefinition,
  decisionsPath: string = path.join(dir, DECISIONS_FILE),
): Promise<Project> {
  const problems: string[] = [];
  const rawProject = await readJson(path.join(dir, PROJECT_FILE), problems);
  const rawDecisions = await readJson(decisionsPath, problems);
  const projectResult =
    rawProject === undefined ? undefined : projectFileSchema.safeParse(rawProject);
  const decisionsResult =
    rawDecisions === undefined ? undefined : decisionsFileSchema.safeParse(rawDecisions);
  if (projectResult?.success === false) {
    problems.push(...zodProblems(PROJECT_FILE, projectResult.error));
  }
  if (decisionsResult?.success === false) {
    problems.push(...zodProblems(path.basename(decisionsPath), decisionsResult.error));
  }
  if (projectResult?.success !== true || decisionsResult?.success !== true) {
    throw new ProjectDirError(dir, problems);
  }
  const spec = projectResult.data;
  const decisions = decisionsResult.data;

  let service: ServiceDefinition | undefined;
  let market: MarketProfile | undefined;
  try {
    service = resolveService(spec.service.id, spec.service.version);
  } catch (error) {
    problems.push(
      `${PROJECT_FILE}: service: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
  try {
    market = registry.getMarket(spec.market.id, spec.market.version);
  } catch (error) {
    problems.push(`${PROJECT_FILE}: market: ${error instanceof Error ? error.message : 'unknown'}`);
  }

  const outputLanguage = spec.outputLanguage ?? market?.default_output_language ?? 'en';
  if (market !== undefined) {
    if (!market.output_languages.includes(outputLanguage)) {
      problems.push(
        `${PROJECT_FILE}: outputLanguage: "${outputLanguage}" is not offered by market ` +
          `${market.id} (${market.output_languages.join(', ')})`,
      );
    }
    try {
      factFormToCandidates(spec.factForm, market);
    } catch (error) {
      if (!(error instanceof FactFormError)) throw error;
      problems.push(`${PROJECT_FILE}: factForm: ${error.message}`);
    }
  }

  if (service !== undefined) {
    for (const input of service.inputs) {
      if (input.type === 'images') {
        if (spec.photos.length < input.min || spec.photos.length > input.max) {
          problems.push(
            `${PROJECT_FILE}: photos: service ${service.id} v${service.version} takes ` +
              `${input.min}–${input.max} photos (input "${input.key}"), got ${spec.photos.length}`,
          );
        }
      } else if (input.type === 'audio' && input.required && spec.voiceMemo === null) {
        problems.push(
          `${PROJECT_FILE}: voiceMemo: service ${service.id} v${service.version} requires a ` +
            `voice walkthrough (input "${input.key}")`,
        );
      }
    }
  }

  const photos = spec.photos.map((file) => ({
    name: path.basename(file),
    path: path.resolve(dir, file),
  }));
  const names = new Set<string>();
  for (const photo of photos) {
    if (names.has(photo.name)) {
      problems.push(`${PROJECT_FILE}: photos: file name "${photo.name}" is used twice`);
    }
    names.add(photo.name);
  }
  const voiceMemoPath = spec.voiceMemo === null ? null : path.resolve(dir, spec.voiceMemo);
  for (const file of [
    ...photos.map((p) => p.path),
    ...(voiceMemoPath === null ? [] : [voiceMemoPath]),
  ]) {
    if (!(await isFile(file))) problems.push(`${PROJECT_FILE}: input file not found: ${file}`);
  }
  for (const entry of decisions.claimAudit.images.decisions) {
    if (!names.has(entry.photo)) {
      problems.push(
        `${path.basename(decisionsPath)}: claimAudit.images: "${entry.photo}" is not a project photo`,
      );
    }
  }

  if (problems.length > 0 || service === undefined || market === undefined) {
    throw new ProjectDirError(dir, problems);
  }
  return {
    dir,
    title: spec.title,
    service,
    market,
    outputLanguage,
    officeProfile: spec.officeProfile,
    factForm: spec.factForm,
    photos,
    voiceMemoPath,
    fixture: spec.fixture,
    fixturesDir:
      spec.fixtureDir === undefined ? META_FIXTURES_DIR : path.resolve(dir, spec.fixtureDir),
    decisions,
  };
}

/** Replaces the project's voice memo (e.g. a local TTS walkthrough that is not committed). */
export async function withVoiceMemo(project: Project, file: string): Promise<Project> {
  if (!(await isFile(file)))
    throw new ProjectDirError(project.dir, [`voice memo not found: ${file}`]);
  return { ...project, voiceMemoPath: file };
}
