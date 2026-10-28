import {
  LISTING_COPY_ARTIFACT_KIND,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  copyGeneratedPayloadSchema,
  photoInventoryContentSchema,
  type CopyGeneratedPayload,
  type ListingCopyContent,
  type MarketProfile,
  type PhotoInventoryContent,
} from '@evidomo/shared';
import type { Executor } from '../../db/client.ts';
import { insertArtifact, listArtifacts, type Artifact } from '../../db/repositories/artifacts.ts';
import { insertClaims } from '../../db/repositories/claims.ts';
import { listFacts } from '../../db/repositories/facts.ts';
import { getProject } from '../../db/repositories/projects.ts';
import { appendRunEvent } from '../../db/repositories/run-events.ts';
import type { Run } from '../../db/repositories/runs.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import { NonRetryableStepError, type StepHandler } from '../../runs/steps.ts';
import {
  buildCopyFactCatalog,
  CopyCatalogError,
  photoContext,
  type CopyFactCatalog,
} from './catalog.ts';
import {
  buildCopyInput,
  buildCopyRequests,
  buildListingCopyContent,
  generateListingCopy,
  type CopySources,
} from './generate.ts';

// Step 5, creative copy (docs/architecture.md §5): the run's verified facts after Gate 1 → one
// Spark call → the portal description and a social caption as claim segments citing stored
// facts, checked in code → a `listing_copy` artifact plus one `claims` row per segment. Copy
// text is personal data: it goes into the artifact and the claims (which cascade with the
// project), never into logs or events. Staging is a separate step (P3-04).

export interface CreativeHandlerDeps {
  readonly markets: Pick<DefinitionRegistry, 'getMarket'>;
}

async function readInventory(db: Executor, runId: string): Promise<PhotoInventoryContent | null> {
  const inventories = await listArtifacts(db, runId, { kind: PHOTO_INVENTORY_ARTIFACT_KIND });
  const [artifact] = inventories;
  if (artifact === undefined) return null;
  if (inventories.length > 1) {
    throw new NonRetryableStepError(
      `The run has ${inventories.length} photo inventories; copy expects at most one`,
    );
  }
  const content = photoInventoryContentSchema.safeParse(artifact.content);
  if (!content.success) {
    throw new NonRetryableStepError('The run photo inventory has an invalid format');
  }
  return content.data;
}

/**
 * The sources of a first draft for a run: its verified facts (form, transcript, photo, and
 * Gate 1 decisions; after Gate 1 these are authoritative, the pre-gate fact sheet is not read),
 * the photo inventory's room list, the project's office tone, and the run's output language.
 * Verification (P3-06) builds its revision requests from the same sources.
 */
export async function loadCopySources(
  db: Executor,
  run: Run,
  market: MarketProfile,
): Promise<CopySources> {
  const project = await getProject(db, run.projectId);
  if (project === undefined) throw new NonRetryableStepError('The run has no project');
  const facts = await listFacts(db, run.id, { status: 'verified' });
  const inventory = await readInventory(db, run.id);
  let catalog: CopyFactCatalog;
  try {
    catalog = buildCopyFactCatalog(market, facts, inventory);
  } catch (error) {
    // Messages name no keys or values.
    if (error instanceof CopyCatalogError) {
      throw new NonRetryableStepError(error.message, { cause: error });
    }
    throw error;
  }
  return {
    market,
    catalog,
    photos: photoContext(inventory),
    tone: project.officeProfile.tone ?? null,
    outputLanguage: run.outputLanguage,
    revision: null,
  };
}

/** What a copy commit wrote; counts are those of the `copy_generated` event. */
export interface StoredListingCopy {
  readonly artifact: Artifact;
  readonly summary: CopyGeneratedPayload;
}

/**
 * Stores one copy draft inside the caller's transaction: the `listing_copy` artifact, a `claims`
 * row per segment (fact IDs as cited, validator and verifier columns still empty), and a
 * `copy_generated` event with counts only. Used by the creative step and by verification's
 * revisions (P3-06).
 */
export async function storeListingCopy(
  tx: Executor,
  params: { readonly runId: string; readonly stepId: string; readonly content: ListingCopyContent },
): Promise<StoredListingCopy> {
  const { runId, stepId, content } = params;
  const artifact = await insertArtifact(tx, {
    runId,
    stepId,
    kind: LISTING_COPY_ARTIFACT_KIND,
    content,
  });
  const segments = content.variants.flatMap((variant) => variant.segments);
  const claims = await insertClaims(
    tx,
    artifact.id,
    segments.map((segment) => ({
      segmentIndex: segment.index,
      text: segment.text,
      factIds: segment.factIds,
    })),
  );
  const segmentCount = (kind: 'portal' | 'social'): number =>
    content.variants.find((variant) => variant.kind === kind)?.segments.length ?? 0;
  const summary = copyGeneratedPayloadSchema.parse({
    stepId,
    artifactId: artifact.id,
    revision: content.revision,
    outputLanguage: content.outputLanguage,
    catalogFactCount: content.counts.catalogFacts,
    citedFactCount: content.counts.citedCatalogFacts,
    portalSegmentCount: segmentCount('portal'),
    socialSegmentCount: segmentCount('social'),
    claimCount: claims.length,
    mergedUncitedCount: content.repairs.mergedUncited,
    droppedUncitedParagraphCount: content.repairs.droppedUncitedParagraphs,
    model: content.modelRun.model,
    fallbackUsed: content.modelRun.fallbackFrom !== null,
  } satisfies CopyGeneratedPayload);
  await appendRunEvent(tx, runId, { type: 'copy_generated', payload: summary });
  return { artifact, summary };
}

export function createCreativeHandler(deps: CreativeHandlerDeps): StepHandler<'creative'> {
  return async (ctx) => {
    const { run, step } = ctx;
    const market = deps.markets.getMarket(run.marketProfileId, run.marketProfileVersion);
    const sources = await loadCopySources(ctx.db, run, market);
    const input = buildCopyInput(sources);
    const generated = await generateListingCopy(
      {
        clients: ctx.metaClients(),
        meter: ctx.ledger.meter.bind(ctx.ledger),
        signal: ctx.signal,
        onFallback: (failure) => {
          ctx.logger.warn(
            { primaryModel: step.model, fallbackModel: step.fallback_model, failure },
            'copy primary model failed; using the fallback model',
          );
        },
      },
      buildCopyRequests(step, market, input),
      sources.catalog,
      sources.outputLanguage,
    );
    const content = buildListingCopyContent({
      generated,
      catalog: sources.catalog,
      input,
      revision: 0,
      previousArtifactId: null,
    });
    ctx.logger.info(
      {
        outputLanguage: content.outputLanguage,
        counts: content.counts,
        repairs: content.repairs,
        languageChecks: content.variants.map((variant) => variant.languageCheck),
        model: content.modelRun.model,
      },
      'listing copy generated',
    );

    return {
      async commit(tx) {
        // Idempotency: the engine runs commit in the completion transaction (run row locked,
        // claim re-checked, at most one completed attempt per step). The check keeps a repeated
        // commit from writing a second copy and claim set even if that contract changes.
        const [existing] = await listArtifacts(tx, run.id, {
          kind: LISTING_COPY_ARTIFACT_KIND,
          stepId: step.id,
        });
        if (existing !== undefined) {
          ctx.logger.warn(
            { artifactId: existing.id },
            'copy already stored for this step; keeping the existing copy',
          );
          return { artifactIds: [existing.id] };
        }
        const stored = await storeListingCopy(tx, { runId: run.id, stepId: step.id, content });
        return { artifactIds: [stored.artifact.id] };
      },
    };
  };
}
