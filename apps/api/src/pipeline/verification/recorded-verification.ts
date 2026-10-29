// The record/replay test body shared by the `verification-*.test.ts` files (one cassette per
// scenario, so each can be re-recorded alone). Imported only by tests.
import { randomUUID } from 'node:crypto';
import {
  claimAuditCategorySchema,
  listingCopyContentSchema,
  qaCardsContentSchema,
  type ClaimAuditCategory,
  type ClaimAuditStopReason,
} from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createLogger } from '../../logger.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { recordedCopyStep } from '../creative/testing.ts';
import { recordedQaStep } from '../qa/testing.ts';
import { draftSegments, qaSegments } from './audit.ts';
import { verifyCopy } from './handler.ts';
import { buildVerificationRubric } from './rubric.ts';
import {
  editQa,
  recordedInitialDraft,
  recordedInitialQa,
  recordedVerifierStep,
  SEEDED_EN_DEFECTS,
  SEEDED_QA_EN_DEFECTS,
  scenarioDraft,
  VERIFICATION_INCLUDED_CASSETTES,
  VERIFICATION_MATCH,
  VERIFICATION_SCENARIOS,
  verificationCassette,
  type VerificationScenario,
} from './testing.ts';

/**
 * What each recording did (deterministic in replay): passes, how it stopped, and the flags per
 * pass as `[source, category]` in stored order. Updated only by a re-recording.
 */
export interface RecordedVerificationOutcome {
  readonly stopReason: ClaimAuditStopReason;
  readonly flagsByPass: readonly (readonly (readonly [string, ClaimAuditCategory])[])[];
  /** Segments sent to the verifier per pass (the rest were carried unchanged). */
  readonly auditedByPass: readonly number[];
}

export function describeRecordedVerification(
  scenario: VerificationScenario,
  expected: RecordedVerificationOutcome,
): void {
  const { language, edits, qa: qaMode } = VERIFICATION_SCENARIOS[scenario];
  const seeded = edits === 'seeded';
  const withQa = qaMode !== 'absent';
  const seededQa = qaMode === 'seeded';
  const replay = createMetaReplay({
    cassette: verificationCassette(scenario),
    include: VERIFICATION_INCLUDED_CASSETTES,
    match: VERIFICATION_MATCH,
  });
  const usage = createInMemoryUsageRecorder();
  const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' });
  let registry: DefinitionRegistry;

  beforeAll(async () => {
    registry = await loadDefinitions();
    await replay.start();
  });

  afterAll(async () => {
    await replay.stop();
  });

  describe(`verification "${scenario}" on Wonder with Spark revisions (${replay.mode})`, () => {
    it('audits the draft, revises flagged segments, and re-audits changed segments only', async () => {
      const clients = createMetaClients({
        apiKey: replay.apiKey,
        usage,
        estimateCost: createPriceTableCostEstimator(),
        maxRetries: 0,
      });
      const draft = await recordedInitialDraft(clients, usage, registry, language);
      usage.clear();
      const initialContent = scenarioDraft(scenario, draft);
      const recordedQa = withQa
        ? await recordedInitialQa(clients, registry, draft, language)
        : null;
      const initialQa =
        recordedQa !== null && seededQa
          ? editQa(recordedQa, draft.sources, SEEDED_QA_EN_DEFECTS)
          : recordedQa;
      usage.clear();
      const initialId = randomUUID();
      const initialQaId = randomUUID();
      const market = draft.sources.market;
      const step = recordedVerifierStep(registry);
      const rubric = buildVerificationRubric(market);

      const startedAt = Date.now();
      let result: Awaited<ReturnType<typeof verifyCopy>> | undefined;
      try {
        result = await verifyCopy(
          { clients: () => clients, meter: (_modelId, call) => call() },
          {
            step,
            creativeStep: recordedCopyStep(registry),
            market,
            sources: draft.sources,
            rubric,
            initial: { content: initialContent, storedId: initialId, provisionalId: initialId },
            qa:
              initialQa === null
                ? null
                : {
                    step: recordedQaStep(registry),
                    initial: {
                      content: initialQa,
                      storedId: initialQaId,
                      provisionalId: initialQaId,
                    },
                  },
          },
        );
      } finally {
        if (replay.mode === 'record') {
          // Usage and counts only; wording is read from the fixture. Logged even on failure:
          // the spend happened either way.
          logger.info(
            {
              scenario,
              wallMs: Date.now() - startedAt,
              calls: usage.entries.map((entry) => ({
                modelId: entry.modelId,
                inputTokens: entry.inputTokens,
                cachedInputTokens: entry.cachedInputTokens,
                outputTokens: entry.outputTokens,
                reasoningTokens: entry.reasoningTokens,
                estimatedCostUsd: entry.estimatedCostUsd,
              })),
              totalUsd: usage.entries.reduce((sum, e) => sum + (e.estimatedCostUsd ?? 0), 0),
              passes: result?.passes.map(({ audit }) => ({
                segments: audit.segments,
                audited: audit.auditedSegments,
                carried: audit.carriedSegments,
                flags: audit.flags.map((f) => [f.source, f.category, f.variant, f.segment]),
                dropped: audit.dropped,
              })),
              stopReason: result?.stopReason,
            },
            'p3-06-measurement',
          );
        }
      }
      replay.assertAllMatched();
      if (result === undefined) throw new Error('unreachable: verifyCopy returned nothing');

      // The rubric: claim support, every phrasing category of the profile, the area basis.
      expect(rubric.map((rule) => rule.category)).toEqual([
        'claim_support',
        'unverifiable_superlative',
        'investment_promise',
        'exclusionary',
        'area_basis',
      ]);

      const { passes } = result;
      const [first] = passes;
      const initialSegments =
        draftSegments(initialContent).length +
        (initialQa === null ? 0 : qaSegments(initialQa).length);
      expect(first?.audit).toMatchObject({
        segments: initialSegments,
        auditedSegments: initialSegments,
        carriedSegments: 0,
        modelRun: {
          model: 'muse-wonder-1.0',
          reasoningEffort: 'low',
          maxOutputTokens: 12000,
          fallbackFrom: null,
        },
      });
      expect(passes.length).toBeLessThanOrEqual(step.max_revision_loops + 1);
      let revisions = 0;
      passes.forEach(({ draft: pass, audit }, i) => {
        const content = listingCopyContentSchema.parse(pass.copy.content);
        const qa = pass.qa === null ? null : qaCardsContentSchema.parse(pass.qa.content);
        expect(qa === null).toBe(initialQa === null);
        expect(audit.auditedSegments + audit.carriedSegments).toBe(audit.segments);
        for (const flag of audit.flags) {
          expect(claimAuditCategorySchema.safeParse(flag.category).success).toBe(true);
          expect(rubric.some((rule) => rule.category === flag.category)).toBe(true);
          const segments =
            flag.variant === 'qa' ? (qa === null ? [] : qaSegments(qa)) : draftSegments(content);
          const segment = segments.find((s) => s.segmentIndex === flag.segmentIndex);
          expect(segment).toMatchObject({ variant: flag.variant, segment: flag.segment });
        }
        const previous = passes[i - 1]?.draft;
        if (previous === undefined) return;
        // A loop revises the copy and the cards only where they have flags; a revision is
        // numbered by its loop and points at the draft it revises.
        const revisedDrafts = [
          { now: pass.copy, before: previous.copy },
          ...(pass.qa === null || previous.qa === null
            ? []
            : [{ now: pass.qa, before: previous.qa }]),
        ].filter(({ now, before }) => now !== before);
        expect(revisedDrafts.length).toBeGreaterThan(0);
        for (const { now, before } of revisedDrafts) {
          revisions += 1;
          expect(now.content.revision).toBe(i);
          expect(now.content.previousArtifactId).toBe(before.provisionalId);
          expect(now.content.modelRun).toMatchObject({
            model: 'muse-spark-1.3',
            fallbackFrom: null,
          });
          expect(now.content.outputLanguage).toBe(language);
        }
      });
      expect(result.stopReason).toBe(expected.stopReason);
      expect(
        passes.map(({ audit }) => audit.flags.map((flag) => [flag.source, flag.category])),
      ).toEqual(expected.flagsByPass);
      expect(passes.map(({ audit }) => audit.auditedSegments)).toEqual(expected.auditedByPass);

      if (seeded) {
        // Every seeded defect is flagged in the first pass, by the expected source.
        const segments = draftSegments(initialContent);
        for (const defect of SEEDED_EN_DEFECTS) {
          const segment = segments.find((s) => s.text === defect.seeded);
          expect(
            first?.audit.flags.some(
              (flag) =>
                flag.segmentIndex === segment?.segmentIndex &&
                flag.source === defect.source &&
                flag.category === defect.category,
            ),
            `${defect.category} in "${defect.seeded}"`,
          ).toBe(true);
        }
      }

      if (initialQa !== null && seededQa) {
        // Every seeded Q&A defect is flagged in the first pass, by the expected source; a
        // question's problem is flagged on the first answer segment of its card.
        for (const defect of SEEDED_QA_EN_DEFECTS) {
          const card = initialQa.cards.find((c) =>
            defect.kind === 'question'
              ? c.question === defect.seeded
              : c.segments.some((s) => s.text === defect.seeded),
          );
          const segment =
            defect.kind === 'question'
              ? card?.segments[0]
              : card?.segments.find((s) => s.text === defect.seeded);
          expect(
            first?.audit.flags.some(
              (flag) =>
                flag.variant === 'qa' &&
                flag.segmentIndex === segment?.index &&
                flag.source === defect.source &&
                flag.category === defect.category,
            ),
            `${defect.category} in "${defect.seeded}"`,
          ).toBe(true);
        }
      }

      // One ledger entry per verifier call and per revision, each well under a cent budget.
      const verifierCalls = passes.filter(({ audit }) => audit.modelRun !== null).length;
      expect(usage.entries).toHaveLength(verifierCalls + revisions);
      for (const entry of usage.entries) expect(entry.estimatedCostUsd).toBeLessThan(0.1);
    }, 600_000);
  });
}
