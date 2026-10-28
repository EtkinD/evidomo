import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError } from '../errors.ts';
import {
  artifacts,
  claims,
  decisions,
  facts,
  materials,
  projects,
  runEvents,
  runs,
  usageLedger,
} from '../schema.ts';
import {
  seedProject,
  seedRun,
  seedUser,
  startTestDatabase,
  type TestDatabase,
} from '../testing.ts';
import { insertArtifact } from './artifacts.ts';
import { insertClaims } from './claims.ts';
import { recordDecision } from './decisions.ts';
import { insertFacts } from './facts.ts';
import { addMaterial, listMaterials, setMaterialStatus } from './materials.ts';
import {
  createProject,
  deleteProject,
  getProject,
  getProjectForOwner,
  listProjectsForOwner,
} from './projects.ts';
import { appendRunEvent } from './run-events.ts';
import { transitionRun } from './runs.ts';
import { recordUsage } from './usage.ts';

const sha = (char: string) => char.repeat(64);

describe('projects and materials repository', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await startTestDatabase();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it('creates and reads back a project with its office profile snapshot and fact form', async () => {
    const owner = await seedUser(testDb.db);

    const created = await createProject(testDb.db, {
      ownerId: owner.id,
      title: 'Canal house',
      officeProfile: { agencyName: 'Example Makelaardij', contactBlock: 'Call us', tone: 'calm' },
      marketProfileId: 'nl',
      marketProfileVersion: 1,
      outputLanguage: 'en',
      factForm: { living_area: 84, energy_label: 'A' },
    });

    expect(created.status).toBe('draft');
    expect(await getProject(testDb.db, created.id)).toEqual(created);
    expect(created.factForm).toEqual({ living_area: 84, energy_label: 'A' });
  });

  it('rejects an invalid office profile before it reaches the database', async () => {
    const owner = await seedUser(testDb.db);

    await expect(
      createProject(testDb.db, {
        ownerId: owner.id,
        title: 'x',
        officeProfile: { agencyName: '   ' },
        marketProfileId: 'nl',
        marketProfileVersion: 1,
        outputLanguage: 'en',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('scopes project lookups to their owner', async () => {
    const owner = await seedUser(testDb.db);
    const stranger = await seedUser(testDb.db);
    const project = await seedProject(testDb.db, owner.id);

    expect((await getProjectForOwner(testDb.db, project.id, owner.id))?.id).toBe(project.id);
    expect(await getProjectForOwner(testDb.db, project.id, stranger.id)).toBeUndefined();
    expect((await listProjectsForOwner(testDb.db, owner.id)).map((p) => p.id)).toEqual([
      project.id,
    ]);
    expect(await listProjectsForOwner(testDb.db, stranger.id)).toEqual([]);
  });

  it('adds materials, lists them per project and kind, and updates processing status', async () => {
    const owner = await seedUser(testDb.db);
    const project = await seedProject(testDb.db, owner.id);

    const photo = await addMaterial(testDb.db, {
      projectId: project.id,
      kind: 'photo',
      storageKey: `projects/${project.id}/photo-1.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 123_456,
      sha256: sha('a'),
    });
    const memo = await addMaterial(testDb.db, {
      projectId: project.id,
      kind: 'voice_memo',
      storageKey: `projects/${project.id}/memo.wav`,
      mimeType: 'audio/wav',
      sizeBytes: 1_000_000,
      sha256: sha('b'),
    });

    expect(photo.status).toBe('uploaded');
    expect((await listMaterials(testDb.db, project.id)).map((m) => m.id)).toEqual([
      photo.id,
      memo.id,
    ]);
    expect(
      (await listMaterials(testDb.db, project.id, { kind: 'photo' })).map((m) => m.id),
    ).toEqual([photo.id]);

    const ready = await setMaterialStatus(testDb.db, photo.id, 'ready', {
      width: 2048,
      height: 1536,
    });
    expect(ready.status).toBe('ready');
    expect(ready.metadata).toEqual({ width: 2048, height: 1536 });

    await expect(
      setMaterialStatus(testDb.db, '00000000-0000-4000-8000-000000000000', 'ready'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('enforces material integrity constraints in the database', async () => {
    const owner = await seedUser(testDb.db);
    const project = await seedProject(testDb.db, owner.id);
    const base = {
      projectId: project.id,
      kind: 'photo' as const,
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      sha256: sha('c'),
    };

    await expect(
      addMaterial(testDb.db, { ...base, storageKey: 'k-bad-hash', sha256: 'not-a-hash' }),
    ).rejects.toMatchObject({ cause: { constraint: 'materials_sha256_hex' } });
    await expect(
      addMaterial(testDb.db, { ...base, storageKey: 'k-zero', sizeBytes: 0 }),
    ).rejects.toMatchObject({ cause: { constraint: 'materials_size_bytes_positive' } });
    await addMaterial(testDb.db, { ...base, storageKey: 'k-dup' });
    await expect(addMaterial(testDb.db, { ...base, storageKey: 'k-dup' })).rejects.toMatchObject({
      cause: { constraint: 'materials_storage_key_unique' },
    });
  });

  it('hard-deletes a project with every derived row and returns its storage keys', async () => {
    const owner = await seedUser(testDb.db);
    const project = await seedProject(testDb.db, owner.id);
    const otherProject = await seedProject(testDb.db, owner.id);
    const otherRun = await seedRun(testDb.db, otherProject.id);

    await addMaterial(testDb.db, {
      projectId: project.id,
      kind: 'photo',
      storageKey: 'delete-me/photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      sha256: sha('d'),
    });
    const run = await seedRun(testDb.db, project.id);
    await transitionRun(testDb.db, run.id, { to: 'running', stepId: 'intake' });
    await appendRunEvent(testDb.db, run.id, {
      type: 'step_started',
      payload: { stepId: 'intake' },
    });
    const [fact] = await insertFacts(testDb.db, run.id, [
      {
        stepId: 'intake',
        key: 'living_area',
        value: 84,
        unit: 'm2',
        source: { kind: 'form', field: 'living_area' },
      },
    ]);
    const copy = await insertArtifact(testDb.db, {
      runId: run.id,
      stepId: 'creative',
      kind: 'copy_portal',
      content: { segments: [] },
    });
    await insertArtifact(testDb.db, {
      runId: run.id,
      stepId: 'creative',
      kind: 'staged_image',
      file: { storageKey: 'delete-me/staged.jpg', mimeType: 'image/jpeg' },
    });
    await insertClaims(testDb.db, copy.id, [
      { segmentIndex: 0, text: '84 m2 of living space', factIds: [fact?.id ?? ''] },
    ]);
    await transitionRun(testDb.db, run.id, { to: 'awaiting_gate', gate: 'fact_conflicts' });
    await recordDecision(testDb.db, {
      runId: run.id,
      gate: 'fact_conflicts',
      targetKind: 'fact',
      targetId: fact?.id ?? '',
      choice: 'accept',
      decidedBy: owner.id,
    });
    const usage = await recordUsage(testDb.db, {
      runId: run.id,
      modelId: 'muse-spark-1.3',
      estimatedCostUsd: '0.0125',
      latencyMs: 900,
    });
    const otherUsage = await recordUsage(testDb.db, {
      runId: otherRun.id,
      modelId: 'muse-spark-1.3',
      estimatedCostUsd: '0.01',
      latencyMs: 900,
    });

    const result = await deleteProject(testDb.db, project.id);

    expect(result.storageKeys.sort()).toEqual(['delete-me/photo.jpg', 'delete-me/staged.jpg']);
    const remaining = await testDb.db.execute<{ table: string; n: string }>(sql`
      select 'projects' as table, count(*)::text as n from ${projects} where ${projects.id} = ${project.id}
      union all select 'materials', count(*)::text from ${materials} where ${materials.projectId} = ${project.id}
      union all select 'runs', count(*)::text from ${runs} where ${runs.id} = ${run.id}
      union all select 'run_events', count(*)::text from ${runEvents} where ${runEvents.runId} = ${run.id}
      union all select 'facts', count(*)::text from ${facts} where ${facts.runId} = ${run.id}
      union all select 'artifacts', count(*)::text from ${artifacts} where ${artifacts.runId} = ${run.id}
      union all select 'claims', count(*)::text from ${claims} where ${claims.artifactId} = ${copy.id}
      union all select 'decisions', count(*)::text from ${decisions} where ${decisions.runId} = ${run.id}
    `);
    expect(remaining.rows.every((r) => r.n === '0')).toBe(true);

    // The ledger keeps cost accounting but loses its link to the deleted run.
    const [orphaned] = await testDb.db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.id, usage.id));
    expect(orphaned?.runId).toBeNull();
    expect(orphaned?.estimatedCostUsd).toBe('0.01250000');

    // Other projects are untouched.
    expect(await getProject(testDb.db, otherProject.id)).toBeDefined();
    const [kept] = await testDb.db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.id, otherUsage.id));
    expect(kept?.runId).toBe(otherRun.id);
  });

  it('reports a missing project on delete', async () => {
    await expect(
      deleteProject(testDb.db, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
