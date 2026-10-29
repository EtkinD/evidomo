import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { portalFieldsSchema } from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../logger.ts';
import { runPipeline, SUMMARY_FILE } from './run.ts';
import type { PipelineSummary } from './summary.ts';

// The headless CLI's whole flow in fixture mode: the committed demo project through upload
// processing, the real run engine and step handlers, both gate services with the scripted
// decisions, and the export, on Testcontainers PostgreSQL, replaying the recorded run
// `fixtures/meta/p3-10/synthetic-walkthrough` through MSW. Replay cannot reach the network: an
// unrecorded Meta request gets a 404 and any other host a network error, and both are listed
// in `unmatched`. Needs Docker and ffmpeg (CI installs it).

const DEMO_PROJECT = path.resolve(
  import.meta.dirname,
  '../../../../fixtures/projects/synthetic-walkthrough',
);
const logger = createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' });

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'evidomo-cli-run-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function fixtureRun(
  outDir: string,
  extra: Partial<Parameters<typeof runPipeline>[0]> = {},
): Promise<PipelineSummary> {
  return runPipeline({
    projectDir: DEMO_PROJECT,
    mode: 'fixtures',
    outDir,
    // A real key must never be needed: replay sends a placeholder.
    env: {},
    logger,
    progress: () => undefined,
    ...extra,
  });
}

describe('headless pipeline CLI, fixture mode', () => {
  it('completes the whole flow with zero network model calls and writes the export', async () => {
    const outDir = path.join(scratch, 'out');
    const summary = await fixtureRun(outDir);

    expect(summary.status).toBe('completed');
    expect(summary.failureReason).toBeNull();
    expect(summary.service.steps).toContain('qa_cards');
    expect(summary.steps.map((s) => [s.stepId, s.status, s.attempts, s.executions])).toEqual(
      summary.service.steps.map((id) => [id, 'completed', 1, 1]),
    );

    // Zero calls: nothing was forwarded, nothing was unmatched or blocked, and every metered
    // call in the usage ledger was answered from the cassette.
    expect(summary.network).toEqual({
      liveRequests: 0,
      servedFromCassette: summary.cost.calls,
      unmatched: [],
      unnamedImages: 0,
    });
    expect(summary.cost.calls).toBeGreaterThan(0);
    expect(summary.cost.byModel.map((m) => m.modelId)).toEqual([
      'muse-image-1.0',
      'muse-spark-1.3',
      'muse-voice-transcribe-1.0',
      'muse-wonder-1.0',
      'sam-3.1',
    ]);

    // Gate 1: the planted conflicts, decided as scripted.
    expect(summary.factConflicts?.decisions).toEqual([
      {
        conflictId: 'K01',
        key: 'build_year',
        decision: 'accept transcript side (1987)',
        origin: 'decisions_file',
      },
      {
        conflictId: 'K02',
        key: 'other:bedroom_floor',
        decision: 'reject every side (no fact form value)',
        origin: 'default_policy',
      },
      {
        conflictId: 'K03',
        key: 'vve_monthly_contribution',
        decision: 'accept form side (175 EUR)',
        origin: 'default_policy',
      },
    ]);
    // Staging furnishes empty rooms only: the furnished edits and the furnished dining room are
    // skipped, the cluttered rooms need the disabled `declutter`, and the empty living room
    // (classified as a bedroom in this recording) takes the one furnish per subject.
    const photo = (name: string) => summary.photos.find((p) => p.photo === name);
    expect(photo('living-empty.jpg')).toMatchObject({
      subject: 'bedroom',
      furnishing: 'empty',
      staging: { status: 'staged', operationId: 'furnish_bedroom', reason: null },
    });
    expect(photo('bedroom-empty.jpg')?.staging).toMatchObject({
      status: 'skipped',
      reason: 'subject_already_furnished',
    });
    for (const name of [
      'dining-chairs.jpg',
      'living-empty.edit-add-sofa.jpg',
      'bedroom-empty.edit-add-bed.jpg',
      'dining-chairs.edit-replace-chairs.jpg',
      'living-dining-cluttered.edit-declutter-table.jpg',
    ]) {
      expect(photo(name)?.furnishing, name).not.toBe('empty');
      expect(photo(name)?.staging, name).toMatchObject({
        status: 'skipped',
        reason: 'room_not_empty',
      });
    }
    expect(summary.photos).toHaveLength(11);
    expect(
      summary.photos.filter((p) => p.staging?.status === 'staged').map((p) => p.photo),
    ).toEqual(['living-empty.jpg']);

    // Buyer Q&A cards (P3-03): written once, validator-clean, and clean in the audit.
    expect(summary.qaCards?.drafts).toEqual([
      expect.objectContaining({
        stepId: 'qa_cards',
        revision: 0,
        cards: 7,
        droppedCards: 0,
        validatorFailedSegments: 0,
      }),
    ]);
    expect(summary.claimAudit?.claims.filter((c) => c.variant === 'qa')).toEqual([]);

    // Gate 2: the staged image the integrity check offered was accepted by the default.
    expect(summary.claimAudit?.images.map((i) => [i.photo, i.choice, i.origin])).toEqual([
      ['living-empty.jpg', 'accept', 'default_policy'],
    ]);
    expect(summary.unusedDecisions).toEqual([]);

    // The export on disk is exactly the manifest's files plus the summary.
    const exported = summary.export;
    if (exported === null) throw new Error('no export');
    expect(exported.readyToPublish).toBe(true);
    expect((await readdir(outDir)).sort()).toEqual(
      [...exported.files.map((f) => f.fileName), SUMMARY_FILE].sort(),
    );
    for (const file of exported.files) {
      const bytes = await readFile(path.join(outDir, file.fileName));
      expect(bytes.byteLength).toBe(file.sizeBytes);
    }
    const fields = portalFieldsSchema.parse(
      JSON.parse(await readFile(path.join(outDir, 'portal-fields.json'), 'utf8')),
    );
    expect(fields.facts.profile.find((f) => f.key === 'build_year')).toMatchObject({
      status: 'verified',
      value: 1987,
    });
    expect(fields.images.filter((i) => i.kind === 'staged')).toHaveLength(1);
    expect(exported.qaCards).toBe(7);
    expect(fields.qaCards).toHaveLength(7);
    expect(fields.qaCards.every((card) => card.question.endsWith('?'))).toBe(true);
    const html = await readFile(path.join(outDir, 'listing-pack.html'), 'utf8');
    expect(html).toContain('Virtually staged');
    expect(html).toContain('<section id="qa">');
    expect(html.match(/<dt>/g)).toHaveLength(7);
    const written: unknown = JSON.parse(await readFile(path.join(outDir, SUMMARY_FILE), 'utf8'));
    expect(written).toEqual(JSON.parse(JSON.stringify(summary)));
  }, 300_000);

  it('stops at the gate, without an export, when a scripted decision cannot be made', async () => {
    const decisionsPath = path.join(scratch, 'strict-decisions.json');
    await writeFile(
      decisionsPath,
      JSON.stringify({
        formatVersion: 1,
        factConflicts: { default: 'fail' },
        claimAudit: { claims: { default: 'remove' }, images: { default: 'accept' } },
      }),
    );
    const summary = await fixtureRun(path.join(scratch, 'strict'), { decisionsPath });

    expect(summary.status).toBe('awaiting_gate');
    expect(summary.failureReason).toMatch(/K01 \(build_year\) is not in the decisions file/);
    expect(summary.factConflicts?.conflicts).toEqual([
      'K01 build_year',
      'K02 other:bedroom_floor',
      'K03 vve_monthly_contribution',
    ]);
    expect(summary.export).toBeNull();
    expect(summary.network?.liveRequests).toBe(0);
    expect(summary.steps.find((s) => s.stepId === 'creative')?.status).toBe('not_started');
  }, 300_000);
});
