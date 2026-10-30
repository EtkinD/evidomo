import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { claimAuditCategorySchema } from '@evidomo/shared';
import { z } from 'zod';
import { cassettePath } from '../meta/fixtures.ts';

// Seeded property sets for the evaluation (`npm run eval`, docs/architecture.md §12
// "Seeded-defect eval"). Each set is a directory under `fixtures/eval/` holding `eval.json`: the
// project it runs (a pipeline project directory, `apps/api/src/cli/project.ts`), its cassette,
// and the machine-readable answer key: the fact conflicts Gate 1 must show, the basis notes the
// sheet must carry, the defects injected into the creative step's first answer, and the phrases
// a tempting office tone may provoke.

export const EVAL_SETS_DIR = path.resolve(import.meta.dirname, '../../../../fixtures/eval');
export const EVAL_SET_FILE = 'eval.json';
export const EVAL_SET_FORMAT_VERSION = 1;

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** A regular expression in the answer key; refused at load time when it does not compile. */
const pattern = z
  .string()
  .min(1)
  .max(200)
  .refine((source) => {
    try {
      new RegExp(source, 'iu');
      return true;
    } catch {
      return false;
    }
  }, 'must be a valid regular expression');

const cassetteName = z.string().refine((name) => {
  try {
    cassettePath(name);
    return true;
  } catch {
    return false;
  }
}, 'must be a cassette name such as "p5-01/control"');

/** Where a conflicted fact came from (`facts.source.kind`; Gate 1 decisions are never planted). */
export const EVAL_SOURCE_KINDS = ['form', 'transcript_turn', 'photo_region'] as const;
const sourceKindSchema = z.enum(EVAL_SOURCE_KINDS);
export type EvalSourceKind = z.infer<typeof sourceKindSchema>;

/**
 * A conflict Gate 1 must show. `planted` names the side that was seeded (a fact-form field, or
 * a source kind plus a key pattern for a contradiction already in the inputs); `against` the
 * source kinds of which at least one must appear on another side of the same conflict.
 */
export const conflictExpectationSchema = z.strictObject({
  id: slug,
  /** `planted`: seeded for this set; `incidental`: a true contradiction of the base inputs. */
  origin: z.enum(['planted', 'incidental']),
  description: z.string().min(1).max(300),
  planted: z.union([
    z.strictObject({ formField: z.string().min(1).max(80) }),
    z.strictObject({ source: sourceKindSchema, key: pattern }),
  ]),
  against: z.array(sourceKindSchema).min(1),
  /** How the conflict is expected to be found: by code (market facts) or by the model. */
  decidedBy: z.enum(['code', 'model']),
});
export type ConflictExpectation = z.infer<typeof conflictExpectationSchema>;

/** A basis note the verified fact sheet must carry (a value on another measure). */
export const basisNoteExpectationSchema = z.strictObject({
  id: slug,
  description: z.string().min(1).max(300),
  key: z.string().min(1),
  value: z.union([z.number(), z.string(), z.boolean()]),
});
export type BasisNoteExpectation = z.infer<typeof basisNoteExpectationSchema>;

const injectionCommon = {
  id: slug,
  description: z.string().min(1).max(300),
  variant: z.enum(['portal', 'social', 'qa']),
  /** The first segment of the variant citing a catalog fact whose key matches. */
  target: pattern,
  expect: z.strictObject({
    category: claimAuditCategorySchema,
    /** Which check is expected to catch it; either counts as caught. */
    detector: z.enum(['validator', 'verifier']),
  }),
};

/**
 * A defect injected into the creative (or Q&A) step's first answer before the pipeline parses
 * it, as if the model had written it. `marker` finds the defect in later drafts and the export;
 * the number operations derive it from the changed number.
 */
export const injectionSchema = z.discriminatedUnion('op', [
  z.strictObject({
    ...injectionCommon,
    op: z.literal('append'),
    /** Appended before the segment's final punctuation, e.g. ", ideal for a young family". */
    text: z.string().min(2).max(200),
    marker: pattern,
  }),
  z.strictObject({
    ...injectionCommon,
    op: z.literal('insert'),
    /** A new segment placed right after the target segment. */
    text: z.string().min(2).max(300),
    /** It cites the first catalog fact whose key matches. */
    cite: pattern,
    marker: pattern,
  }),
  z.strictObject({
    ...injectionCommon,
    op: z.literal('replace_number'),
    /** The cited number of the target fact is replaced by itself plus `delta`. */
    delta: z
      .number()
      .int()
      .refine((delta) => delta !== 0, 'must change the number'),
  }),
  z.strictObject({
    ...injectionCommon,
    op: z.literal('approximate'),
    /** Written directly before the target fact's number, e.g. "about". */
    prefix: z.string().min(1).max(30),
  }),
]);
export type Injection = z.infer<typeof injectionSchema>;

/** Wording a tempting input may provoke; found by pattern, so a rephrasing escapes it. */
export const temptationSchema = z.strictObject({
  id: slug,
  description: z.string().min(1).max(300),
  category: claimAuditCategorySchema,
  marker: pattern,
});
export type Temptation = z.infer<typeof temptationSchema>;

export const evalSetFileSchema = z
  .strictObject({
    formatVersion: z.literal(EVAL_SET_FORMAT_VERSION),
    id: slug,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    /** The pipeline project directory, relative to the set's directory. */
    project: z.string().min(1).max(300).default('.'),
    /** The set's cassette under `fixtures/meta/`. */
    cassette: cassetteName,
    /** Cassettes served read-only before the set's own (shared pre-gate and staging calls). */
    include: z.array(cassetteName).max(4).default([]),
    conflicts: z.array(conflictExpectationSchema),
    basisNotes: z.array(basisNoteExpectationSchema).default([]),
    injections: z.array(injectionSchema).default([]),
    temptations: z.array(temptationSchema).default([]),
  })
  .superRefine((set, ctx) => {
    const ids = [
      ...set.conflicts.map((c) => c.id),
      ...set.basisNotes.map((b) => b.id),
      ...set.injections.map((i) => i.id),
      ...set.temptations.map((t) => t.id),
    ];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `Answer key ID "${id}" twice` });
      seen.add(id);
    }
  });
export type EvalSetFile = z.infer<typeof evalSetFileSchema>;

export interface EvalSet extends EvalSetFile {
  /** The set's directory. */
  readonly dir: string;
  /** The project directory, resolved. */
  readonly projectDir: string;
}

export class EvalSetError extends Error {
  override name = 'EvalSetError';
}

/** Reads and validates one set directory. */
export async function loadEvalSet(dir: string): Promise<EvalSet> {
  const file = path.join(dir, EVAL_SET_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new EvalSetError(
      `${file}: ${error instanceof SyntaxError ? 'not valid JSON' : 'cannot be read'}`,
      { cause: error },
    );
  }
  const parsed = evalSetFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EvalSetError(`${file}:\n${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.id !== path.basename(dir)) {
    throw new EvalSetError(`${file}: id "${parsed.data.id}" must equal its directory name`);
  }
  return { ...parsed.data, dir, projectDir: path.resolve(dir, parsed.data.project) };
}

/** Every set under `root` (directories holding `eval.json`), in directory-name order. */
export async function loadEvalSets(root: string = EVAL_SETS_DIR): Promise<EvalSet[]> {
  const names = (await readdir(root)).sort();
  const sets: EvalSet[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    if (!(await stat(dir)).isDirectory()) continue;
    try {
      await stat(path.join(dir, EVAL_SET_FILE));
    } catch {
      continue;
    }
    sets.push(await loadEvalSet(dir));
  }
  return sets;
}

/** The sets named in `ids` (all when empty), refusing unknown names. */
export function selectEvalSets(sets: readonly EvalSet[], ids: readonly string[]): EvalSet[] {
  if (ids.length === 0) return [...sets];
  const unknown = ids.filter((id) => !sets.some((set) => set.id === id));
  if (unknown.length > 0) {
    throw new EvalSetError(
      `Unknown eval set(s): ${unknown.join(', ')} (known: ${sets.map((s) => s.id).join(', ')})`,
    );
  }
  return sets.filter((set) => ids.includes(set.id));
}
