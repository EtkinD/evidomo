import { randomUUID } from 'node:crypto';
import type { FactSource } from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError } from '../errors.ts';
import { seedRunWithParents, startTestDatabase, type TestDatabase } from '../testing.ts';
import { getArtifact, insertArtifact, listArtifacts } from './artifacts.ts';
import { insertClaims, listClaims, recordVerifierVerdict } from './claims.ts';
import { insertFacts, listFacts, setFactStatus } from './facts.ts';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb.stop();
});

describe('facts repository', () => {
  it('stores value, unit, basis, and each provenance kind, and reads them back', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const transcript = await insertArtifact(testDb.db, {
      runId: run.id,
      stepId: 'intake',
      kind: 'transcript',
      content: { turns: [] },
    });
    const photoId = randomUUID();
    const sources: FactSource[] = [
      { kind: 'form', field: 'living_area' },
      {
        kind: 'transcript_turn',
        transcriptArtifactId: transcript.id,
        turnIndex: 3,
        startMs: 41_200,
        endMs: 45_900,
      },
      {
        kind: 'photo_region',
        materialId: photoId,
        region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      },
    ];

    const inserted = await insertFacts(testDb.db, run.id, [
      {
        stepId: 'fact_extraction',
        key: 'living_area',
        value: 84,
        unit: 'm2',
        basis: 'NEN2580',
        source: sources[0] ?? never(),
      },
      {
        stepId: 'fact_extraction',
        key: 'living_area',
        value: 90,
        unit: 'm2',
        source: sources[1] ?? never(),
      },
      {
        stepId: 'vision_inventory',
        key: 'has_balcony',
        value: true,
        source: sources[2] ?? never(),
      },
    ]);

    expect(inserted.map((f) => f.source)).toEqual(sources);
    expect(inserted[0]).toMatchObject({
      value: 84,
      unit: 'm2',
      basis: 'NEN2580',
      status: 'candidate',
    });
    expect(inserted[1]).toMatchObject({ basis: null });

    const listed = await listFacts(testDb.db, run.id);
    expect(listed.map((f) => f.key)).toEqual(['has_balcony', 'living_area', 'living_area']);
    // Facts inserted in one statement share created_at; the order then falls back to id.
    const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : 1);
    expect(await listFacts(testDb.db, run.id, { key: 'living_area' })).toEqual(
      inserted.slice(0, 2).sort(byId),
    );
  });

  it('rejects a fact whose provenance is malformed', async () => {
    const { run } = await seedRunWithParents(testDb.db);

    await expect(
      insertFacts(testDb.db, run.id, [
        {
          stepId: 'fact_extraction',
          key: 'living_area',
          value: 84,
          source: {
            kind: 'transcript_turn',
            transcriptArtifactId: randomUUID(),
            turnIndex: 0,
            startMs: 5000,
            endMs: 1000,
          },
        },
      ]),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(await listFacts(testDb.db, run.id)).toEqual([]);
  });

  it('updates statuses only for facts of the given run and filters by status', async () => {
    const a = await seedRunWithParents(testDb.db);
    const b = await seedRunWithParents(testDb.db);
    const source = { kind: 'form', field: 'build_year' } as const;
    const [factA1, factA2] = await insertFacts(testDb.db, a.run.id, [
      { stepId: 'fact_extraction', key: 'build_year', value: 1931, source },
      { stepId: 'fact_extraction', key: 'build_year', value: 1913, source },
    ]);
    const [factB] = await insertFacts(testDb.db, b.run.id, [
      { stepId: 'fact_extraction', key: 'build_year', value: 1931, source },
    ]);

    const ids = [factA1?.id, factA2?.id, factB?.id].filter((id) => id !== undefined);
    expect(await setFactStatus(testDb.db, a.run.id, ids, 'conflicted')).toBe(2);

    expect((await listFacts(testDb.db, a.run.id, { status: 'conflicted' })).length).toBe(2);
    expect((await listFacts(testDb.db, b.run.id))[0]?.status).toBe('candidate');
    expect(await setFactStatus(testDb.db, a.run.id, [], 'verified')).toBe(0);
  });
});

describe('artifacts and claims repository', () => {
  it('stores structured and file artifacts with the producing model call IDs', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const usageId = randomUUID();

    const sheet = await insertArtifact(testDb.db, {
      runId: run.id,
      stepId: 'reconciliation',
      kind: 'fact_sheet',
      content: { facts: ['f1'] },
      usageIds: [usageId],
    });
    const image = await insertArtifact(testDb.db, {
      runId: run.id,
      stepId: 'creative',
      kind: 'staged_image',
      file: { storageKey: `runs/${run.id}/staged-1.jpg`, mimeType: 'image/jpeg' },
    });

    expect(sheet).toMatchObject({
      usageIds: [usageId],
      storageKey: null,
      content: { facts: ['f1'] },
    });
    expect(image).toMatchObject({ content: null, mimeType: 'image/jpeg', usageIds: [] });
    expect(await getArtifact(testDb.db, sheet.id)).toEqual(sheet);
    expect((await listArtifacts(testDb.db, run.id)).map((a) => a.id)).toEqual([sheet.id, image.id]);
    expect(await listArtifacts(testDb.db, run.id, { kind: 'staged_image' })).toEqual([image]);
    await expect(
      insertArtifact(testDb.db, { runId: run.id, stepId: 's', kind: 'Not Snake', content: {} }),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('keeps claims in segment order with cited IDs, validator result, and verifier verdict', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const copy = await insertArtifact(testDb.db, {
      runId: run.id,
      stepId: 'creative',
      kind: 'copy_portal',
      content: { language: 'en' },
    });
    const factId = randomUUID();

    await insertClaims(testDb.db, copy.id, [
      {
        segmentIndex: 1,
        text: 'A sunny balcony.',
        factIds: ['not-a-uuid'],
        validatorResult: 'fail',
        validatorDetails: { reason: 'unknown_fact_id', factId: 'not-a-uuid' },
      },
      {
        segmentIndex: 0,
        text: '84 m2 of living space.',
        factIds: [factId],
        validatorResult: 'pass',
      },
    ]);

    const claims = await listClaims(testDb.db, copy.id);
    expect(claims.map((c) => [c.segmentIndex, c.factIds, c.validatorResult])).toEqual([
      [0, [factId], 'pass'],
      [1, ['not-a-uuid'], 'fail'],
    ]);
    expect(claims[1]?.validatorDetails).toEqual({
      reason: 'unknown_fact_id',
      factId: 'not-a-uuid',
    });

    const verified = await recordVerifierVerdict(testDb.db, claims[0]?.id ?? never(), 'supported', {
      rubric: ['claim_support'],
    });
    expect(verified).toMatchObject({
      verifierVerdict: 'supported',
      verifierDetails: { rubric: ['claim_support'] },
    });
    await expect(recordVerifierVerdict(testDb.db, randomUUID(), 'flagged')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      insertClaims(testDb.db, copy.id, [{ segmentIndex: 0, text: 'dup', factIds: [] }]),
    ).rejects.toMatchObject({ cause: { constraint: 'claims_artifact_segment_key' } });
  });
});

function never(): never {
  throw new Error('fixture value missing');
}
