import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DecisionAlreadyRecordedError, GateNotOpenError, NotFoundError } from '../errors.ts';
import { seedRunWithParents, startTestDatabase, type TestDatabase } from '../testing.ts';
import { insertArtifact } from './artifacts.ts';
import { insertClaims } from './claims.ts';
import { listDecisions, recordDecision, upsertDecisions } from './decisions.ts';
import { insertFacts, type Fact } from './facts.ts';
import { transitionRun, type Run } from './runs.ts';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb.stop();
});

async function runAtGate1(): Promise<{ run: Run; userId: string; facts: Fact[] }> {
  const { run, user } = await seedRunWithParents(testDb.db);
  await transitionRun(testDb.db, run.id, { to: 'running' });
  const facts = await insertFacts(testDb.db, run.id, [
    {
      stepId: 'reconciliation',
      key: 'living_area',
      value: 84,
      unit: 'm2',
      status: 'conflicted',
      source: { kind: 'form', field: 'living_area' },
    },
    {
      stepId: 'reconciliation',
      key: 'build_year',
      value: 1931,
      status: 'conflicted',
      source: { kind: 'form', field: 'build_year' },
    },
  ]);
  const paused = await transitionRun(testDb.db, run.id, {
    to: 'awaiting_gate',
    gate: 'fact_conflicts',
  });
  return { run: paused, userId: user.id, facts };
}

describe('decisions repository', () => {
  it('records accept and edit decisions while the run awaits the gate', async () => {
    const { run, userId, facts } = await runAtGate1();
    const [area, year] = facts;
    if (!area || !year) throw new Error('fixture facts missing');

    const accepted = await recordDecision(testDb.db, {
      runId: run.id,
      gate: 'fact_conflicts',
      targetKind: 'fact',
      targetId: area.id,
      choice: 'accept',
      decidedBy: userId,
    });
    const edited = await recordDecision(testDb.db, {
      runId: run.id,
      gate: 'fact_conflicts',
      targetKind: 'fact',
      targetId: year.id,
      choice: 'edit',
      editedValue: 1932,
      decidedBy: userId,
    });

    expect(accepted).toMatchObject({ choice: 'accept', editedValue: null, decidedBy: userId });
    expect(accepted.decidedAt).toBeInstanceOf(Date);
    expect(edited.editedValue).toBe(1932);
    expect((await listDecisions(testDb.db, run.id)).map((d) => d.id)).toEqual([
      accepted.id,
      edited.id,
    ]);
    expect(await listDecisions(testDb.db, run.id, { gate: 'claim_audit' })).toEqual([]);
  });

  it('upserts one decision per target, replacing the earlier choice and value', async () => {
    const { run, userId, facts } = await runAtGate1();
    const [area, year] = facts;
    if (!area || !year) throw new Error('fixture facts missing');
    const base = {
      runId: run.id,
      gate: 'fact_conflicts',
      targetKind: 'fact',
      decidedBy: userId,
    } as const;

    const first = await upsertDecisions(testDb.db, [
      { ...base, targetId: area.id, choice: 'accept' },
      { ...base, targetId: year.id, choice: 'reject' },
    ]);
    const second = await upsertDecisions(testDb.db, [
      { ...base, targetId: area.id, choice: 'edit', editedValue: { value: 85 } },
      { ...base, targetId: year.id, choice: 'edit', editedValue: { value: 85 } },
    ]);

    // Same rows (same IDs), new choice and value.
    expect(second.map((d) => d.id).sort()).toEqual(first.map((d) => d.id).sort());
    const stored = await listDecisions(testDb.db, run.id, { gate: 'fact_conflicts' });
    expect(stored.map((d) => [d.targetId, d.choice, d.editedValue]).sort()).toEqual(
      [
        [area.id, 'edit', { value: 85 }],
        [year.id, 'edit', { value: 85 }],
      ].sort(),
    );
    expect(await upsertDecisions(testDb.db, [])).toEqual([]);
  });

  it('refuses decisions when the run is not paused at that gate', async () => {
    const { run, userId, facts } = await runAtGate1();
    const target = facts[0]?.id ?? '';

    await expect(
      recordDecision(testDb.db, {
        runId: run.id,
        gate: 'claim_audit',
        targetKind: 'fact',
        targetId: target,
        choice: 'accept',
        decidedBy: userId,
      }),
    ).rejects.toBeInstanceOf(GateNotOpenError);

    await transitionRun(testDb.db, run.id, { to: 'running' });
    await expect(
      recordDecision(testDb.db, {
        runId: run.id,
        gate: 'fact_conflicts',
        targetKind: 'fact',
        targetId: target,
        choice: 'accept',
        decidedBy: userId,
      }),
    ).rejects.toBeInstanceOf(GateNotOpenError);
  });

  it('refuses a second decision for the same target', async () => {
    const { run, userId, facts } = await runAtGate1();
    const decision = {
      runId: run.id,
      gate: 'fact_conflicts',
      targetKind: 'fact',
      targetId: facts[0]?.id ?? '',
      choice: 'reject',
      decidedBy: userId,
    } as const;

    await recordDecision(testDb.db, decision);
    await expect(recordDecision(testDb.db, decision)).rejects.toBeInstanceOf(
      DecisionAlreadyRecordedError,
    );
    expect(await listDecisions(testDb.db, run.id)).toHaveLength(1);
  });

  it('refuses targets that do not belong to the run', async () => {
    const { run, userId } = await runAtGate1();
    const other = await runAtGate1();

    await expect(
      recordDecision(testDb.db, {
        runId: run.id,
        gate: 'fact_conflicts',
        targetKind: 'fact',
        targetId: other.facts[0]?.id ?? '',
        choice: 'accept',
        decidedBy: userId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      recordDecision(testDb.db, {
        runId: randomUUID(),
        gate: 'fact_conflicts',
        targetKind: 'fact',
        targetId: randomUUID(),
        choice: 'accept',
        decidedBy: userId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('accepts claim and artifact targets at the claim audit gate', async () => {
    const { run, user } = await seedRunWithParents(testDb.db);
    await transitionRun(testDb.db, run.id, { to: 'running' });
    const copy = await insertArtifact(testDb.db, {
      runId: run.id,
      stepId: 'creative',
      kind: 'copy_portal',
      content: {},
    });
    const image = await insertArtifact(testDb.db, {
      runId: run.id,
      stepId: 'creative',
      kind: 'staged_image',
      file: { storageKey: `runs/${run.id}/staged.jpg`, mimeType: 'image/jpeg' },
    });
    const [claim] = await insertClaims(testDb.db, copy.id, [
      { segmentIndex: 0, text: 'The best house in town.', factIds: [] },
    ]);
    await transitionRun(testDb.db, run.id, { to: 'awaiting_gate', gate: 'claim_audit' });

    await recordDecision(testDb.db, {
      runId: run.id,
      gate: 'claim_audit',
      targetKind: 'claim',
      targetId: claim?.id ?? '',
      choice: 'remove',
      decidedBy: user.id,
    });
    await recordDecision(testDb.db, {
      runId: run.id,
      gate: 'claim_audit',
      targetKind: 'artifact',
      targetId: image.id,
      choice: 'accept',
      decidedBy: user.id,
    });

    expect((await listDecisions(testDb.db, run.id)).map((d) => d.targetKind)).toEqual([
      'claim',
      'artifact',
    ]);
  });
});
