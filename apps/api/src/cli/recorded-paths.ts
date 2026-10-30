import { readFile, writeFile } from 'node:fs/promises';
import { conflictSideSchema, type GateConflict } from '@evidomo/shared';
import { z } from 'zod';
import type { FactConflictEntry, PlannedConflictDecision } from './decisions.ts';

// Recorded Gate 1 paths of a cassette (docs/architecture.md §5 "Development seed"). Everything
// after Gate 1 is matched on the decided facts, so a replay can follow only Gate 1 decisions
// somebody recorded. A cassette may hold several such paths at once (their post-gate requests
// differ, so their keys never collide); this file, `<cassette>.paths.json` next to the cassette,
// lists them so `dev:seed` can print them and `--path` can pick one.
//
// A path is a full combination: one choice per conflict, in Gate 1's conflict order. Choices are
// "accept side n" (1-based, as Gate 1 lists the sides) or "reject"; a free-text edit cannot be
// pre-recorded. A path ID writes the choices in conflict order, e.g. `2-x-1` (accept side 2 of
// the first conflict, reject the second, accept side 1 of the third); `none` when there is no
// conflict.

export const RECORDED_PATHS_FORMAT_VERSION = 1;
export const NO_CONFLICTS_PATH_ID = 'none';

const snapshotSideSchema = conflictSideSchema.pick({
  key: true,
  value: true,
  unit: true,
  basis: true,
  sourceKinds: true,
});

const snapshotConflictSchema = z.strictObject({
  key: z.string().min(1),
  sides: z.array(snapshotSideSchema).min(2),
});
export type ConflictSnapshot = z.infer<typeof snapshotConflictSchema>;

/** The decisions file's Gate 1 entries, restricted to what a path can hold. */
const pathEntrySchema = z.discriminatedUnion('choice', [
  z.strictObject({
    key: z.string().min(1),
    choice: z.literal('accept'),
    side: z.strictObject({ position: z.int().min(1).max(20) }),
  }),
  z.strictObject({ key: z.string().min(1), choice: z.literal('reject') }),
]);
export type PathEntry = z.infer<typeof pathEntrySchema>;

const recordedPathSchema = z.strictObject({
  id: z.string().regex(/^(none|(\d+|x)(-(\d+|x))*)$/),
  decisions: z.array(pathEntrySchema),
  /** Recorded with the project's own decisions file (its Gate 1 policy), not `--gate1-path`. */
  fromProjectDecisions: z.boolean(),
  recordedAt: z.iso.datetime(),
  /** Requests the session sent live (0 when everything was already in the cassette). */
  liveRequests: z.int().nonnegative(),
});
export type RecordedPath = z.infer<typeof recordedPathSchema>;

const recordedPathsFileSchema = z.strictObject({
  formatVersion: z.literal(RECORDED_PATHS_FORMAT_VERSION),
  cassette: z.string().min(1),
  /** Gate 1 as the recording saw it, in gate order. */
  conflicts: z.array(snapshotConflictSchema),
  paths: z.array(recordedPathSchema),
});
export type RecordedPathsFile = z.infer<typeof recordedPathsFileSchema>;

export class RecordedPathsError extends Error {
  override name = 'RecordedPathsError';
}

/** `<dir>/<name>.json` → `<dir>/<name>.paths.json`. */
export function recordedPathsFile(cassetteFile: string): string {
  return cassetteFile.replace(/\.json$/, '.paths.json');
}

export function snapshotConflicts(conflicts: readonly GateConflict[]): ConflictSnapshot[] {
  return conflicts.map((conflict) => ({
    key: conflict.key,
    sides: conflict.sides.map((side) => ({
      key: side.key,
      value: side.value,
      unit: side.unit,
      basis: side.basis,
      sourceKinds: [...side.sourceKinds],
    })),
  }));
}

function sameConflicts(a: readonly ConflictSnapshot[], b: readonly ConflictSnapshot[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every choice a conflict offers that can be pre-recorded: accept each side, or reject. */
export function conflictOptions(conflict: ConflictSnapshot): PathEntry[] {
  return [
    ...conflict.sides.map((_, index): PathEntry => ({
      key: conflict.key,
      choice: 'accept',
      side: { position: index + 1 },
    })),
    { key: conflict.key, choice: 'reject' },
  ];
}

function choiceToken(entry: PathEntry): string {
  return entry.choice === 'reject' ? 'x' : String(entry.side.position);
}

/** The ID of a path: one token per conflict, in conflict order. */
export function pathId(
  conflicts: readonly ConflictSnapshot[],
  entries: readonly PathEntry[],
): string {
  if (conflicts.length === 0) return NO_CONFLICTS_PATH_ID;
  return conflicts
    .map((conflict) => {
      const entry = entries.find((e) => e.key === conflict.key);
      if (entry === undefined) {
        throw new RecordedPathsError(`The path has no decision for conflict "${conflict.key}"`);
      }
      return choiceToken(entry);
    })
    .join('-');
}

/** The decisions of the path `id`; throws for an ID that does not fit the conflicts. */
export function pathEntries(conflicts: readonly ConflictSnapshot[], id: string): PathEntry[] {
  if (conflicts.length === 0) {
    if (id === NO_CONFLICTS_PATH_ID) return [];
    throw new RecordedPathsError(
      `Gate 1 has no conflicts; the only path is "${NO_CONFLICTS_PATH_ID}"`,
    );
  }
  const tokens = id.split('-');
  if (tokens.length !== conflicts.length) {
    throw new RecordedPathsError(
      `Path "${id}" has ${tokens.length} choice(s), Gate 1 has ${conflicts.length} conflict(s)`,
    );
  }
  return conflicts.map((conflict, index): PathEntry => {
    const token = tokens[index] ?? '';
    if (token === 'x') return { key: conflict.key, choice: 'reject' };
    const position = /^\d+$/.test(token) ? Number(token) : Number.NaN;
    if (!(position >= 1 && position <= conflict.sides.length)) {
      throw new RecordedPathsError(
        `Path "${id}": "${token}" is not a choice for conflict "${conflict.key}" ` +
          `(1–${conflict.sides.length} accepts that side, x rejects every side)`,
      );
    }
    return { key: conflict.key, choice: 'accept', side: { position } };
  });
}

/**
 * Every path, in recording priority: `defaultId` first, then each path that changes exactly one
 * conflict from it (conflict order, then option order), then all other combinations
 * (lexicographic by option index). The product of options per conflict in total.
 */
export function enumeratePaths(
  conflicts: readonly ConflictSnapshot[],
  defaultId: string,
): string[] {
  if (conflicts.length === 0) return [NO_CONFLICTS_PATH_ID];
  const options = conflicts.map((conflict) => conflictOptions(conflict).map(choiceToken));
  const base = pathEntries(conflicts, defaultId).map(choiceToken);
  const ordered: string[] = [base.join('-')];
  const seen = new Set(ordered);
  const add = (tokens: readonly string[]): void => {
    const id = tokens.join('-');
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };
  options.forEach((choices, index) => {
    for (const token of choices) add(base.map((t, i) => (i === index ? token : t)));
  });
  const product = (index: number, prefix: readonly string[]): void => {
    const choices = options[index];
    if (choices === undefined) {
      add(prefix);
      return;
    }
    for (const token of choices) product(index + 1, [...prefix, token]);
  };
  product(0, []);
  return ordered;
}

/**
 * The path a run took, from the Gate 1 decisions applied to `conflicts` (the gate's own
 * response, sides in gate order). Null when a decision cannot be pre-recorded (an edit).
 */
export function pathFromDecisions(
  conflicts: readonly GateConflict[],
  decisions: readonly PlannedConflictDecision[],
): PathEntry[] | null {
  const entries: PathEntry[] = [];
  for (const decision of decisions) {
    const conflict = conflicts.find((c) => c.id === decision.conflictId);
    if (conflict === undefined) {
      throw new RecordedPathsError(`Decision for unknown conflict ${decision.conflictId}`);
    }
    const { request } = decision;
    switch (request.choice) {
      case 'reject':
        entries.push({ key: conflict.key, choice: 'reject' });
        break;
      case 'accept': {
        const index = conflict.sides.findIndex((side) =>
          side.facts.some((fact) => fact.id === request.factId),
        );
        if (index < 0) {
          throw new RecordedPathsError(
            `Conflict ${conflict.id} (${conflict.key}): the accepted fact is on no side`,
          );
        }
        entries.push({ key: conflict.key, choice: 'accept', side: { position: index + 1 } });
        break;
      }
      case 'edit':
        return null;
      default: {
        const unreachable: never = request;
        throw new Error(`Unhandled decision ${JSON.stringify(unreachable)}`);
      }
    }
  }
  return entries;
}

/** The decisions file's Gate 1 section that makes a run take `entries`. */
export function factConflictsForPath(entries: readonly PathEntry[]): {
  default: 'fail';
  decisions: FactConflictEntry[];
} {
  return { default: 'fail', decisions: entries.map((entry) => ({ ...entry })) };
}

function describeSide(side: ConflictSnapshot['sides'][number]): string {
  const unit = side.unit === null ? '' : ` ${side.unit}`;
  const basis = side.basis === null ? '' : ` ${side.basis}`;
  return `${JSON.stringify(side.value)}${unit}${basis}; ${side.sourceKinds.join('+')}`;
}

/** One line per choice, e.g. `accept side 2 ("1987"; transcript_turn)`. */
export function describeEntry(conflict: ConflictSnapshot, entry: PathEntry): string {
  if (entry.choice === 'reject') return 'reject every side';
  const side = conflict.sides[entry.side.position - 1];
  return side === undefined
    ? `accept side ${entry.side.position}`
    : `accept side ${entry.side.position} (${describeSide(side)})`;
}

export async function readRecordedPaths(file: string): Promise<RecordedPathsFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new RecordedPathsError(`${file} is not valid JSON`, { cause: error });
  }
  const parsed = recordedPathsFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new RecordedPathsError(
      `${file} has an invalid format:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

async function writeRecordedPaths(file: string, data: RecordedPathsFile): Promise<void> {
  const validated = recordedPathsFileSchema.parse(data);
  await writeFile(file, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
}

export interface RecordGate1Options {
  readonly file: string;
  readonly cassette: string;
  readonly conflicts: readonly ConflictSnapshot[];
  /** The path the session completed, or undefined when it stopped at Gate 1. */
  readonly path?: Omit<RecordedPath, 'id'> | undefined;
}

export interface RecordGate1Result {
  readonly file: RecordedPathsFile;
  /** Earlier paths dropped because Gate 1 itself changed (they can no longer be reached). */
  readonly dropped: readonly string[];
  readonly pathId: string | null;
}

/**
 * Writes Gate 1's conflicts and, if given, the completed path into the paths file (replacing an
 * earlier entry with the same ID). When the conflicts differ from the file's, every earlier path
 * is dropped: a replay of this cassette can no longer reach them.
 */
export async function recordGate1(options: RecordGate1Options): Promise<RecordGate1Result> {
  const existing = await readRecordedPaths(options.file);
  const conflicts = [...options.conflicts];
  const keep = existing !== undefined && sameConflicts(existing.conflicts, conflicts);
  const dropped = existing !== undefined && !keep ? existing.paths.map((p) => p.id) : [];
  let paths = keep ? [...existing.paths] : [];
  let id: string | null = null;
  if (options.path !== undefined) {
    id = pathId(conflicts, options.path.decisions);
    const previous = paths.find((p) => p.id === id);
    const recorded: RecordedPath = {
      id,
      ...options.path,
      // A path recorded once from the decisions file stays the project's default.
      fromProjectDecisions:
        options.path.fromProjectDecisions || previous?.fromProjectDecisions === true,
    };
    paths = [...paths.filter((p) => p.id !== id), recorded];
  }
  const file: RecordedPathsFile = {
    formatVersion: RECORDED_PATHS_FORMAT_VERSION,
    cassette: options.cassette,
    conflicts,
    paths,
  };
  await writeRecordedPaths(options.file, file);
  return { file, dropped, pathId: id };
}

/** The project's default path among the recorded ones (recorded from its decisions file). */
export function defaultPath(file: RecordedPathsFile): RecordedPath | undefined {
  return file.paths.find((p) => p.fromProjectDecisions);
}

/** Lines for an operator: the recorded choices per conflict, then every recorded path. */
export function formatRecordedPaths(file: RecordedPathsFile): string[] {
  const lines: string[] = [];
  const total = enumerateCount(file.conflicts);
  const fallback = defaultPath(file);
  lines.push('Gate 1 conflicts and their choices (* = used by a recorded path):');
  file.conflicts.forEach((conflict, index) => {
    const tokens = new Set(
      file.paths.map((p) => p.id.split('-')[index]).filter((t) => t !== undefined),
    );
    lines.push(`  ${index + 1}. ${conflict.key}`);
    for (const option of conflictOptions(conflict)) {
      const token = choiceToken(option);
      const mark = tokens.has(token) ? '*' : ' ';
      lines.push(`     ${mark} [${token}] ${describeEntry(conflict, option)}`);
    }
  });
  lines.push(
    `Recorded paths: ${file.paths.length} of ${total} combinations` +
      (file.paths.length === total ? ' (every combination)' : ''),
  );
  const sorted = [...file.paths].sort((a, b) => a.id.localeCompare(b.id));
  for (const recorded of sorted) {
    const isDefault = recorded.id === fallback?.id ? ' (default)' : '';
    lines.push(`  ${recorded.id}${isDefault}`);
  }
  return lines;
}

function enumerateCount(conflicts: readonly ConflictSnapshot[]): number {
  return conflicts.reduce((product, conflict) => product * (conflict.sides.length + 1), 1);
}

/**
 * Every combination in recording priority (`enumeratePaths` from the default path, or plain
 * product order without one), each marked recorded or not, with its choices spelled out.
 */
export function formatPathPlan(file: RecordedPathsFile): string[] {
  const recorded = new Set(file.paths.map((p) => p.id));
  const fallback = defaultPath(file);
  const ids =
    fallback === undefined
      ? enumeratePaths(
          file.conflicts,
          file.conflicts.length === 0
            ? NO_CONFLICTS_PATH_ID
            : file.conflicts.map(() => '1').join('-'),
        ).sort((a, b) => a.localeCompare(b))
      : enumeratePaths(file.conflicts, fallback.id);
  return ids.map((id) => {
    const entries = pathEntries(file.conflicts, id);
    const choices = file.conflicts
      .map((conflict, index) => {
        const entry = entries[index];
        return entry === undefined ? '' : `${conflict.key}: ${describeEntry(conflict, entry)}`;
      })
      .join('; ');
    return `${recorded.has(id) ? 'recorded' : 'missing '} ${id}${id === fallback?.id ? ' (default)' : ''}  ${choices}`;
  });
}
