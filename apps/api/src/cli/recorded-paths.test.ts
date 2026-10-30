import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GateConflict, GateFact } from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planFactConflictDecisions, decisionsFileSchema } from './decisions.ts';
import {
  conflictOptions,
  defaultPath,
  enumeratePaths,
  factConflictsForPath,
  formatPathPlan,
  formatRecordedPaths,
  pathEntries,
  pathFromDecisions,
  pathId,
  readRecordedPaths,
  recordedPathsFile,
  recordGate1,
  RecordedPathsError,
  snapshotConflicts,
  type ConflictSnapshot,
} from './recorded-paths.ts';

// Synthetic Gate 1 conflicts only (no recorded project content).

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fact(id: number, key: string, kind: 'form' | 'transcript_turn', value: number): GateFact {
  return {
    id: uuid(id),
    key,
    value,
    unit: null,
    basis: null,
    status: 'conflicted',
    assertion: 'stated',
    source:
      kind === 'form'
        ? { kind, field: key }
        : {
            kind,
            transcriptArtifactId: uuid(900),
            turnIndex: 1,
            startMs: 0,
            endMs: 10,
            quote: 'q',
          },
  };
}

function conflict(id: string, key: string, sides: readonly (readonly GateFact[])[]): GateConflict {
  return {
    id,
    key,
    kind: 'value_mismatch',
    detectedBy: ['code'],
    explanation: 'values differ',
    decision: null,
    sides: sides.map((facts) => ({
      key,
      value: typeof facts[0]?.value === 'number' ? facts[0].value : 0,
      unit: null,
      basis: null,
      factIds: facts.map((f) => f.id),
      evidenceIds: facts.map((_, i) => `C0${i + 1}`),
      sourceKinds: [...new Set(facts.map((f) => f.source.kind))],
      facts: [...facts],
    })),
  };
}

const gateConflicts: GateConflict[] = [
  conflict('K01', 'build_year', [
    [fact(1, 'build_year', 'form', 1990)],
    [fact(2, 'build_year', 'transcript_turn', 1991)],
  ]),
  conflict('K02', 'room_count', [
    [fact(3, 'room_count', 'transcript_turn', 4)],
    [fact(4, 'room_count', 'transcript_turn', 5)],
  ]),
];
const conflicts: ConflictSnapshot[] = snapshotConflicts(gateConflicts);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'evidomo-recorded-paths-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('path IDs', () => {
  it('offers accept per side and reject for every conflict', () => {
    expect(conflictOptions(conflicts[0] ?? { key: '', sides: [] })).toEqual([
      { key: 'build_year', choice: 'accept', side: { position: 1 } },
      { key: 'build_year', choice: 'accept', side: { position: 2 } },
      { key: 'build_year', choice: 'reject' },
    ]);
  });

  it('round-trips an ID and refuses one that does not fit Gate 1', () => {
    const entries = pathEntries(conflicts, '2-x');
    expect(entries).toEqual([
      { key: 'build_year', choice: 'accept', side: { position: 2 } },
      { key: 'room_count', choice: 'reject' },
    ]);
    expect(pathId(conflicts, entries)).toBe('2-x');
    expect(() => pathEntries(conflicts, '3-x')).toThrow(/"3" is not a choice for conflict/);
    expect(() => pathEntries(conflicts, '1')).toThrow(RecordedPathsError);
    expect(pathEntries([], 'none')).toEqual([]);
    expect(pathId([], [])).toBe('none');
  });

  it('enumerates the default, then single changes, then the rest of the product', () => {
    const order = enumeratePaths(conflicts, '1-x');
    expect(order.slice(0, 5)).toEqual(['1-x', '2-x', 'x-x', '1-1', '1-2']);
    expect(order).toHaveLength(9);
    expect(new Set(order).size).toBe(9);
  });

  it('turns applied decisions into a path, and a path back into decisions that replay it', () => {
    const decisionsFile = decisionsFileSchema.parse({
      formatVersion: 1,
      factConflicts: {
        default: 'accept_form_else_reject',
        decisions: [{ key: 'room_count', choice: 'accept', side: { value: 5 } }],
      },
      claimAudit: { claims: { default: 'remove' }, images: { default: 'accept' } },
    });
    const gate = {
      runId: uuid(1000),
      runStatus: 'awaiting_gate' as const,
      state: 'open' as const,
      factSheetArtifactId: uuid(800),
      conflictsArtifactId: uuid(801),
      conflictCount: 2,
      openCount: 2,
      conflicts: gateConflicts,
    };
    const applied = planFactConflictDecisions(gate, decisionsFile.factConflicts).decisions;
    const entries = pathFromDecisions(gateConflicts, applied);
    expect(entries === null ? null : pathId(conflicts, entries)).toBe('1-2');

    const replanned = planFactConflictDecisions(
      gate,
      factConflictsForPath(pathEntries(conflicts, '1-2')),
    ).decisions;
    expect(replanned.map((d) => d.request)).toEqual(applied.map((d) => d.request));

    const edited = planFactConflictDecisions(gate, {
      default: 'reject',
      decisions: [{ key: 'build_year', choice: 'edit', value: 1989 }],
    }).decisions;
    expect(pathFromDecisions(gateConflicts, edited)).toBeNull();
  });
});

describe('the recorded paths file', () => {
  const recorded = (id: string, fromProjectDecisions: boolean) => ({
    decisions: pathEntries(conflicts, id),
    fromProjectDecisions,
    recordedAt: '2026-10-30T12:00:00.000Z',
    liveRequests: 3,
  });

  it('lives next to the cassette and accumulates paths, keeping the default', async () => {
    const file = recordedPathsFile(path.join(dir, 'run.json'));
    expect(file).toBe(path.join(dir, 'run.paths.json'));
    expect(await readRecordedPaths(file)).toBeUndefined();

    await recordGate1({ file, cassette: 'run', conflicts });
    expect((await readRecordedPaths(file))?.paths).toEqual([]);
    await recordGate1({ file, cassette: 'run', conflicts, path: recorded('1-x', true) });
    await recordGate1({ file, cassette: 'run', conflicts, path: recorded('2-1', false) });
    // The same path again (e.g. recorded with --gate1-path) stays the default.
    const again = await recordGate1({
      file,
      cassette: 'run',
      conflicts,
      path: recorded('1-x', false),
    });
    expect(again.pathId).toBe('1-x');
    const saved = await readRecordedPaths(file);
    expect(saved?.paths.map((p) => p.id)).toEqual(['2-1', '1-x']);
    expect(saved === undefined ? undefined : defaultPath(saved)?.id).toBe('1-x');

    const lines = saved === undefined ? [] : formatRecordedPaths(saved);
    expect(lines).toContain('Recorded paths: 2 of 9 combinations');
    expect(lines).toContain('  1-x (default)');
    expect(lines).toContain('     * [x] reject every side');
    expect(lines).toContain('       [2] accept side 2 (5; transcript_turn)');
    const plan = saved === undefined ? [] : formatPathPlan(saved);
    expect(plan[0]).toMatch(/^recorded 1-x \(default\)/);
    expect(plan.filter((line) => line.startsWith('missing'))).toHaveLength(7);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ formatVersion: 1 });
  });

  it('drops every earlier path when Gate 1 itself changed', async () => {
    const file = path.join(dir, 'changed.paths.json');
    await recordGate1({ file, cassette: 'changed', conflicts, path: recorded('1-x', true) });
    const fewer = conflicts.slice(0, 1);
    const result = await recordGate1({ file, cassette: 'changed', conflicts: fewer });
    expect(result.dropped).toEqual(['1-x']);
    expect((await readRecordedPaths(file))?.paths).toEqual([]);
  });
});
