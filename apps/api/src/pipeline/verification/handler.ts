import { randomUUID } from 'node:crypto';
import {
  CLAIM_AUDIT_ARTIFACT_KIND,
  LISTING_COPY_ARTIFACT_KIND,
  claimAuditContentSchema,
  claimVerifierDetailsSchema,
  claimsAuditedPayloadSchema,
  listingCopyContentSchema,
  verifierVerdictFor,
  type ClaimAuditContent,
  type ClaimAuditFlag,
  type ClaimAuditPass,
  type ClaimAuditRule,
  type ClaimsAuditedPayload,
  type ListingCopyContent,
  type MarketProfile,
  type ServiceDefinition,
} from '@evidomo/shared';
import type { Executor } from '../../db/client.ts';
import { insertArtifact, listArtifacts } from '../../db/repositories/artifacts.ts';
import { listClaims, recordVerifierVerdict } from '../../db/repositories/claims.ts';
import { appendRunEvent } from '../../db/repositories/run-events.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type { MetaClients } from '../../meta/clients.ts';
import {
  NonRetryableStepError,
  type StepConfig,
  type StepHandler,
  type StepLedger,
} from '../../runs/steps.ts';
import type { CopyFactCatalog } from '../creative/catalog.ts';
import {
  buildCopyInput,
  buildCopyRequests,
  buildListingCopyContent,
  copyFailureClass,
  generateListingCopy,
  toCopyDraft,
  type CopySources,
} from '../creative/generate.ts';
import { loadCopySources, storeListingCopy } from '../creative/handler.ts';
import { auditDraft, toRevisionFlags, type DraftAudit, type VerdictMemory } from './audit.ts';
import { buildVerificationRequests, verifyWithFallback } from './call.ts';
import { runRevisionLoop, type LoopResult } from './loop.ts';
import { buildVerificationRubric } from './rubric.ts';
import { VERIFICATION_PROMPT_VERSION } from './step-prompt.ts';

// Step 8, verification (docs/architecture.md §5): the creative step's copy → the claim
// validator's findings plus one Wonder audit (Spark fallback) against a rubric built from the
// market profile → up to `max_revision_loops` revisions through the creative step's own
// functions (and settings), each audited again, changed segments only → every revision as a
// `listing_copy` artifact, verifier verdicts on every audited claim, and one `claim_audit`
// artifact with the remaining flags. The run always stops at Gate 2 (`claim_audit`), even when
// nothing is flagged: the operator signs off on the copy and the staged images there. Copy,
// problems, and suggestions are personal data: artifacts and claims only, never logs or events.

export interface VerificationHandlerDeps {
  readonly markets: Pick<DefinitionRegistry, 'getMarket'>;
}

/** A draft during the loop; revisions are stored only in `commit`. */
export interface VerificationDraft {
  readonly content: ListingCopyContent;
  /** The stored artifact's ID; null for a revision not yet stored. */
  readonly storedId: string | null;
  /**
   * The ID the next revision's `previousArtifactId` points at until commit: the stored ID, or a
   * provisional UUID that commit replaces with the inserted artifact's ID.
   */
  readonly provisionalId: string;
}

export function creativeStepOf(service: ServiceDefinition): StepConfig<'creative'> {
  const steps = service.steps.filter(
    (step): step is StepConfig<'creative'> => step.agent === 'creative',
  );
  const [step] = steps;
  if (step === undefined || steps.length > 1) {
    throw new NonRetryableStepError(
      `Verification needs exactly one creative step in service ${service.id} v${service.version}; found ${steps.length}`,
    );
  }
  return step;
}

async function readInitialDraft(
  db: Executor,
  runId: string,
  creativeStepId: string,
): Promise<VerificationDraft> {
  const drafts = await listArtifacts(db, runId, {
    kind: LISTING_COPY_ARTIFACT_KIND,
    stepId: creativeStepId,
  });
  const [artifact] = drafts;
  if (artifact === undefined || drafts.length > 1) {
    throw new NonRetryableStepError(
      `Verification expects one listing copy from the creative step; found ${drafts.length}`,
    );
  }
  const content = listingCopyContentSchema.safeParse(artifact.content);
  if (!content.success) throw new NonRetryableStepError('The listing copy has an invalid format');
  return { content: content.data, storedId: artifact.id, provisionalId: artifact.id };
}

/**
 * Revisions cite catalog IDs, which are derived from the verified facts; if those changed after
 * the copy was written, the draft's IDs would point at other facts.
 */
function assertSameCatalog(content: ListingCopyContent, catalog: CopyFactCatalog): void {
  const current = JSON.stringify(catalog.facts.map((fact) => [fact.id, [...fact.factIds]]));
  const written = JSON.stringify(content.catalog.map((entry) => [entry.id, entry.factIds]));
  if (current !== written) {
    throw new NonRetryableStepError(
      'The verified facts changed after the copy was written; the copy must be generated again',
    );
  }
}

/**
 * The class of a failure inside a revision loop that ends the loop at the last audited draft,
 * or `undefined` to fail the execution (abort, budget, configuration, programming errors).
 * A truncated revision arrives as `NonRetryableStepError` (creative's `classifyCopyError`) whose
 * cause is the model's failure; any other `NonRetryableStepError` is configuration.
 */
export function revisionFailureClass(error: unknown, signal?: AbortSignal): string | undefined {
  const cause =
    error instanceof NonRetryableStepError && error.cause !== undefined ? error.cause : error;
  return copyFailureClass(cause, signal);
}

export interface VerificationLoopDeps {
  /** Called only when a model call is needed, so a run without calls never needs the API key. */
  readonly clients: () => MetaClients;
  readonly meter: StepLedger['meter'];
  readonly signal?: AbortSignal;
  /** Told about a fallback (step ID and class name only), for the step log. */
  readonly onFallback?: (stepId: string, failure: string) => void;
}

/**
 * The audit and revision loop over one initial draft, without storage: the handler stores the
 * result in `commit`; the replay tests run it on recorded drafts.
 */
export function verifyCopy(
  deps: VerificationLoopDeps,
  params: {
    readonly step: StepConfig<'verifier'>;
    readonly creativeStep: StepConfig<'creative'>;
    readonly market: MarketProfile;
    readonly sources: CopySources;
    readonly rubric: readonly ClaimAuditRule[];
    readonly initial: VerificationDraft;
  },
): Promise<LoopResult<VerificationDraft, DraftAudit>> {
  const { step, market, creativeStep, sources, rubric } = params;
  const memory: VerdictMemory = new Map();
  const callDeps = (stepId: string) => ({
    clients: deps.clients(),
    meter: deps.meter,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    onFallback: (failure: string) => deps.onFallback?.(stepId, failure),
  });
  return runRevisionLoop<VerificationDraft, DraftAudit>({
    initial: params.initial,
    maxRevisionLoops: step.max_revision_loops,
    failureClass: (error) => revisionFailureClass(error, deps.signal),
    audit: (draft) =>
      auditDraft({
        content: draft.content,
        catalog: sources.catalog,
        market,
        rubric,
        memory,
        verify: (request) =>
          verifyWithFallback(callDeps(step.id), buildVerificationRequests(step, request)),
      }),
    revise: async (draft, audit, revision) => {
      const flags = toRevisionFlags(audit.flags);
      if (flags.length === 0) throw new Error('A flagged draft produced no revision flags');
      const input = buildCopyInput({
        ...sources,
        revision: { draft: toCopyDraft(draft.content), flags },
      });
      const generated = await generateListingCopy(
        callDeps(creativeStep.id),
        buildCopyRequests(creativeStep, market, input),
        sources.catalog,
        sources.outputLanguage,
      );
      const content = buildListingCopyContent({
        generated,
        catalog: sources.catalog,
        facts: sources.facts,
        input,
        revision,
        previousArtifactId: draft.provisionalId,
      });
      return { content, storedId: null, provisionalId: randomUUID() };
    },
  });
}

/** The stored flags of one pass: the draft's artifact and each segment's claim attached. */
function storedFlags(
  audit: DraftAudit,
  artifactId: string,
  claimIdByIndex: ReadonlyMap<number, string>,
): ClaimAuditFlag[] {
  return audit.flags.map((flag) => {
    const claimId = claimIdByIndex.get(flag.segmentIndex);
    if (claimId === undefined) throw new Error('An audited segment has no claim row');
    return { ...flag, artifactId, claimId };
  });
}

export function createVerificationHandler(deps: VerificationHandlerDeps): StepHandler<'verifier'> {
  return async (ctx) => {
    const { run, step } = ctx;
    const market = deps.markets.getMarket(run.marketProfileId, run.marketProfileVersion);
    const creativeStep = creativeStepOf(ctx.service);
    const initial = await readInitialDraft(ctx.db, run.id, creativeStep.id);
    const sources = await loadCopySources(ctx.db, run, market);
    assertSameCatalog(initial.content, sources.catalog);
    if (initial.content.outputLanguage !== sources.outputLanguage) {
      throw new NonRetryableStepError('The listing copy is not in the run output language');
    }
    const rubric = buildVerificationRubric(market);
    const result = await verifyCopy(
      {
        clients: () => ctx.metaClients(),
        meter: ctx.ledger.meter.bind(ctx.ledger),
        signal: ctx.signal,
        onFallback: (stepId, failure) => {
          ctx.logger.warn({ stepId, failure }, 'primary model failed; using the fallback model');
        },
      },
      { step, creativeStep, market, sources, rubric, initial },
    );
    const finalAudit = result.passes.at(-1)?.audit;
    ctx.logger.info(
      {
        // Counts only: flags quote copy text and stay in the artifact and the claims.
        stopReason: result.stopReason,
        failure: result.failure ?? null,
        passes: result.passes.map(({ audit }) => ({
          segments: audit.segments,
          audited: audit.auditedSegments,
          carried: audit.carriedSegments,
          validatorFlags: audit.flags.filter((f) => f.source === 'validator').length,
          verifierFlags: audit.flags.filter((f) => f.source === 'verifier').length,
          dropped: audit.dropped,
          model: audit.modelRun?.model ?? null,
        })),
        remainingFlags: finalAudit?.flags.length ?? 0,
      },
      'claims audited',
    );

    return {
      async commit(tx) {
        // Idempotency: the engine runs commit in the completion transaction (run row locked,
        // claim re-checked, at most one completed attempt per step); the check keeps a repeated
        // commit from writing a second audit and revision set even if that contract changes.
        const [existing] = await listArtifacts(tx, run.id, {
          kind: CLAIM_AUDIT_ARTIFACT_KIND,
          stepId: step.id,
        });
        if (existing !== undefined) {
          ctx.logger.warn(
            { artifactId: existing.id },
            'claim audit already stored for this step; keeping the existing audit',
          );
          const revisions = await listArtifacts(tx, run.id, {
            kind: LISTING_COPY_ARTIFACT_KIND,
            stepId: step.id,
          });
          return { artifactIds: [existing.id, ...revisions.map((r) => r.id)] };
        }

        // Revisions in order, each pointing at the stored artifact it revises.
        const storedIdOf = new Map<string, string>();
        const draftIds: string[] = [];
        for (const { draft } of result.passes) {
          if (draft.storedId !== null) {
            draftIds.push(draft.storedId);
            continue;
          }
          const previous = draft.content.previousArtifactId;
          const content = listingCopyContentSchema.parse({
            ...draft.content,
            previousArtifactId: previous === null ? null : (storedIdOf.get(previous) ?? previous),
          });
          const stored = await storeListingCopy(tx, { runId: run.id, stepId: step.id, content });
          storedIdOf.set(draft.provisionalId, stored.artifact.id);
          draftIds.push(stored.artifact.id);
        }

        const claimsByPass = await Promise.all(draftIds.map((id) => listClaims(tx, id)));
        const passes: ClaimAuditPass[] = result.passes.map(({ draft, audit }, i) => {
          const artifactId = draftIds[i] ?? '';
          const claimIdByIndex = new Map(
            (claimsByPass[i] ?? []).map((claim) => [claim.segmentIndex, claim.id]),
          );
          return {
            draftArtifactId: artifactId,
            revision: draft.content.revision,
            segments: audit.segments,
            auditedSegments: audit.auditedSegments,
            carriedSegments: audit.carriedSegments,
            modelRun: audit.modelRun,
            flags: storedFlags(audit, artifactId, claimIdByIndex),
            dropped: audit.dropped,
          };
        });
        const last = passes.at(-1);
        if (last === undefined) throw new Error('unreachable: no audit pass');
        const remaining = last.flags;
        const content = claimAuditContentSchema.parse({
          schemaVersion: 1,
          promptVersion: VERIFICATION_PROMPT_VERSION,
          outputLanguage: sources.outputLanguage,
          market: { id: market.id, version: market.version },
          rubric: [...rubric],
          maxRevisionLoops: step.max_revision_loops,
          stopReason: result.stopReason,
          initialDraftArtifactId: initial.provisionalId,
          finalDraftArtifactId: last.draftArtifactId,
          passes,
          remainingFlags: remaining,
          counts: {
            passes: passes.length,
            revisions: passes.length - 1,
            verifierCalls: passes.filter((pass) => pass.modelRun !== null).length,
            remainingFlags: remaining.length,
            remainingValidatorFlags: remaining.filter((f) => f.source === 'validator').length,
            remainingVerifierFlags: remaining.filter((f) => f.source === 'verifier').length,
            flaggedClaims: new Set(remaining.map((flag) => flag.claimId)).size,
            finalClaims: last.segments,
          },
          fallbackUsed: passes.some((pass) => pass.modelRun?.fallbackFrom != null),
        } satisfies ClaimAuditContent);
        const auditArtifact = await insertArtifact(tx, {
          runId: run.id,
          stepId: step.id,
          kind: CLAIM_AUDIT_ARTIFACT_KIND,
          content,
        });

        // The verifier's verdict on every claim of every audited draft.
        for (const [i, { audit }] of result.passes.entries()) {
          for (const claim of claimsByPass[i] ?? []) {
            const flags = audit.verifierFlagsByIndex.get(claim.segmentIndex) ?? [];
            await recordVerifierVerdict(
              tx,
              claim.id,
              verifierVerdictFor(flags),
              claimVerifierDetailsSchema.parse({
                promptVersion: VERIFICATION_PROMPT_VERSION,
                auditArtifactId: auditArtifact.id,
                pass: i,
                carried: audit.carriedIndexes.has(claim.segmentIndex),
                flags: flags.map((flag) => ({ ...flag })),
              }),
            );
          }
        }

        const lastModel = [...passes].reverse().find((pass) => pass.modelRun !== null)?.modelRun;
        const summary = claimsAuditedPayloadSchema.parse({
          stepId: step.id,
          artifactId: auditArtifact.id,
          finalDraftArtifactId: content.finalDraftArtifactId,
          passCount: content.counts.passes,
          revisionCount: content.counts.revisions,
          verifierCallCount: content.counts.verifierCalls,
          stopReason: content.stopReason,
          remainingFlagCount: content.counts.remainingFlags,
          remainingValidatorFlagCount: content.counts.remainingValidatorFlags,
          remainingVerifierFlagCount: content.counts.remainingVerifierFlags,
          flaggedClaimCount: content.counts.flaggedClaims,
          model: lastModel?.model ?? null,
          fallbackUsed: content.fallbackUsed,
        } satisfies ClaimsAuditedPayload);
        await appendRunEvent(tx, run.id, { type: 'claims_audited', payload: summary });
        // Never `releaseGate`: Gate 2 is where the operator approves the copy and the staged
        // images, so the run stops there even with no remaining flags.
        return { artifactIds: [auditArtifact.id, ...draftIds.slice(1)] };
      },
    };
  };
}
