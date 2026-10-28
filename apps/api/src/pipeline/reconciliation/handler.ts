import {
  FACT_CONFLICTS_ARTIFACT_KIND,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  TRANSCRIPT_ARTIFACT_KIND,
  VERIFIED_FACT_SHEET_ARTIFACT_KIND,
  factConflictsContentSchema,
  factsReconciledPayloadSchema,
  photoInventoryContentSchema,
  transcriptArtifactContentSchema,
  verifiedFactSheetContentSchema,
  type FactStatus,
  type PhotoInventoryContent,
  type ReconciliationModelRun,
  type VerifiedFactSheetContent,
} from '@evidomo/shared';
import type { Executor } from '../../db/client.ts';
import { insertArtifact, listArtifacts } from '../../db/repositories/artifacts.ts';
import { listFacts, setFactStatus } from '../../db/repositories/facts.ts';
import { appendRunEvent } from '../../db/repositories/run-events.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import { NonRetryableStepError, type StepHandler } from '../../runs/steps.ts';
import { reconcileWithFallback, buildReconciliationRequests } from './call.ts';
import { buildCatalog, CatalogError, type Catalog, type CatalogSources } from './catalog.ts';
import { resolveReconciliation, type ReconciliationResult } from './resolve.ts';
import type { ReconciliationStepOutput } from './schema.ts';
import { RECONCILIATION_PROMPT_VERSION } from './step-prompt.ts';

// Step 4, reconciliation (docs/architecture.md §5): the run's candidate facts (form, transcript,
// photos) → one Wonder judgment (Spark fallback), verified in code → the Verified Fact Sheet, the
// conflict list, and a status for every candidate. Conflicts stop the run at Gate 1; without
// conflicts the gate is released and the run continues. Values and explanations are personal
// data: they go into the artifacts (which cascade with the project), never into logs or events.

export interface ReconciliationHandlerDeps {
  readonly markets: Pick<DefinitionRegistry, 'getMarket'>;
}

async function readTranscript(db: Executor, runId: string): Promise<CatalogSources['transcript']> {
  const transcripts = await listArtifacts(db, runId, { kind: TRANSCRIPT_ARTIFACT_KIND });
  const [artifact] = transcripts;
  if (artifact === undefined) return null;
  if (transcripts.length > 1) {
    throw new NonRetryableStepError(
      `The run has ${transcripts.length} transcripts; reconciliation expects at most one`,
    );
  }
  const content = transcriptArtifactContentSchema.safeParse(artifact.content);
  if (!content.success) throw new NonRetryableStepError('The run transcript has an invalid format');
  return { artifactId: artifact.id, turns: content.data.turns };
}

async function readInventory(db: Executor, runId: string): Promise<PhotoInventoryContent | null> {
  const inventories = await listArtifacts(db, runId, { kind: PHOTO_INVENTORY_ARTIFACT_KIND });
  const [artifact] = inventories;
  if (artifact === undefined) return null;
  if (inventories.length > 1) {
    throw new NonRetryableStepError(
      `The run has ${inventories.length} photo inventories; reconciliation expects at most one`,
    );
  }
  const content = photoInventoryContentSchema.safeParse(artifact.content);
  if (!content.success) {
    throw new NonRetryableStepError('The run photo inventory has an invalid format');
  }
  return content.data;
}

/**
 * The model is needed only for transcript and photo candidates: form values alone are compared
 * by code and contradict nothing.
 */
export function needsModel(catalog: Catalog): boolean {
  return catalog.input.candidates.length > 0 || catalog.input.photos.length > 0;
}

export function buildFactSheet(
  catalog: Catalog,
  result: ReconciliationResult,
  modelRun: ReconciliationModelRun | null,
): VerifiedFactSheetContent {
  const statusCount = (status: FactStatus): number =>
    result.outcomes.filter((outcome) => outcome.status === status).length;
  return verifiedFactSheetContentSchema.parse({
    schemaVersion: 1,
    promptVersion: RECONCILIATION_PROMPT_VERSION,
    modelRun,
    counts: {
      candidates: catalog.items.length,
      verified: statusCount('verified'),
      conflicted: statusCount('conflicted'),
      rejected: statusCount('rejected'),
      entries: result.entries.length,
      conflicts: result.conflicts.length,
      basisNotes: result.basisNotes.length,
    },
    entries: result.entries,
    basisNotes: result.basisNotes,
    outcomes: result.outcomes,
    diagnostics: result.diagnostics,
  } satisfies VerifiedFactSheetContent);
}

export function createReconciliationHandler(
  deps: ReconciliationHandlerDeps,
): StepHandler<'reconciler'> {
  return async (ctx) => {
    const { run, step } = ctx;
    const market = deps.markets.getMarket(run.marketProfileId, run.marketProfileVersion);

    const facts = await listFacts(ctx.db, run.id, { status: 'candidate' });
    let catalog: Catalog;
    try {
      catalog = buildCatalog({
        market,
        facts,
        transcript: await readTranscript(ctx.db, run.id),
        inventory: await readInventory(ctx.db, run.id),
      });
    } catch (error) {
      // Messages name evidence kinds and catalog IDs only, never values or quotes.
      if (error instanceof CatalogError) {
        throw new NonRetryableStepError(error.message, { cause: error });
      }
      throw error;
    }

    let output: ReconciliationStepOutput | null = null;
    let modelRun: ReconciliationModelRun | null = null;
    if (needsModel(catalog)) {
      const answer = await reconcileWithFallback(
        {
          clients: ctx.metaClients(),
          meter: ctx.ledger.meter.bind(ctx.ledger),
          signal: ctx.signal,
          onFallback: (failure) => {
            ctx.logger.warn(
              { primaryModel: step.model, fallbackModel: step.fallback_model, failure },
              'reconciliation primary model failed; using the fallback model',
            );
          },
        },
        buildReconciliationRequests(step, catalog.input),
      );
      output = answer.output;
      modelRun = answer.modelRun;
    }

    const result = resolveReconciliation(market, catalog, output);
    const sheet = buildFactSheet(catalog, result, modelRun);
    const summary = {
      candidateCount: sheet.counts.candidates,
      verifiedCount: sheet.counts.verified,
      conflictedCount: sheet.counts.conflicted,
      rejectedCount: sheet.counts.rejected,
      entryCount: sheet.counts.entries,
      conflictCount: sheet.counts.conflicts,
      basisNoteCount: sheet.counts.basisNotes,
      model: modelRun?.model ?? null,
      fallbackUsed: modelRun?.fallbackFrom != null,
    };
    ctx.logger.info({ ...summary, diagnostics: result.diagnostics }, 'facts reconciled');

    const byStatus = new Map<FactStatus, string[]>();
    for (const outcome of result.outcomes) {
      byStatus.set(outcome.status, [...(byStatus.get(outcome.status) ?? []), outcome.factId]);
    }

    return {
      async commit(tx) {
        // Idempotency: the engine runs commit in the completion transaction (run row locked,
        // claim re-checked, at most one completed attempt per step). The check keeps a repeated
        // commit from writing a second sheet or re-deciding facts even if that contract changes.
        const [existing] = await listArtifacts(tx, run.id, {
          kind: VERIFIED_FACT_SHEET_ARTIFACT_KIND,
          stepId: step.id,
        });
        if (existing !== undefined) {
          const conflictArtifacts = await listArtifacts(tx, run.id, {
            kind: FACT_CONFLICTS_ARTIFACT_KIND,
            stepId: step.id,
          });
          const stored = factConflictsContentSchema.safeParse(conflictArtifacts[0]?.content);
          ctx.logger.warn(
            { artifactId: existing.id },
            'facts already reconciled for this step; keeping the existing fact sheet',
          );
          return {
            artifactIds: [existing.id, ...conflictArtifacts.map((artifact) => artifact.id)],
            releaseGate: stored.success && stored.data.conflicts.length === 0,
          };
        }
        const sheetArtifact = await insertArtifact(tx, {
          runId: run.id,
          stepId: step.id,
          kind: VERIFIED_FACT_SHEET_ARTIFACT_KIND,
          content: sheet,
        });
        const conflictsArtifact = await insertArtifact(tx, {
          runId: run.id,
          stepId: step.id,
          kind: FACT_CONFLICTS_ARTIFACT_KIND,
          content: factConflictsContentSchema.parse({
            schemaVersion: 1,
            factSheetArtifactId: sheetArtifact.id,
            conflicts: result.conflicts,
          }),
        });
        for (const [status, ids] of byStatus) {
          const updated = await setFactStatus(tx, run.id, ids, status);
          if (updated !== ids.length) {
            // A fact disappeared between read and commit: refuse to complete on a partial set.
            throw new Error('Reconciled facts changed before the step could commit');
          }
        }
        await appendRunEvent(tx, run.id, {
          type: 'facts_reconciled',
          payload: factsReconciledPayloadSchema.parse({
            stepId: step.id,
            artifactId: sheetArtifact.id,
            conflictsArtifactId: conflictsArtifact.id,
            ...summary,
          }),
        });
        return {
          artifactIds: [sheetArtifact.id, conflictsArtifact.id],
          // Gate 1 only stops the run when a human has something to decide.
          releaseGate: result.conflicts.length === 0,
        };
      },
    };
  };
}
