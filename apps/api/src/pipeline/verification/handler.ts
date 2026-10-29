import { randomUUID } from 'node:crypto';
import {
  CLAIM_AUDIT_ARTIFACT_KIND,
  LISTING_COPY_ARTIFACT_KIND,
  QA_CARDS_ARTIFACT_KIND,
  claimAuditContentSchema,
  claimVerifierDetailsSchema,
  claimsAuditedPayloadSchema,
  listingCopyContentSchema,
  qaCardsContentSchema,
  verifierVerdictFor,
  type ClaimAuditContent,
  type ClaimAuditFlag,
  type ClaimAuditPass,
  type ClaimAuditRule,
  type ClaimsAuditedPayload,
  type ListingCopyContent,
  type MarketProfile,
  type QaCardsContent,
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
import {
  buildQaCardsContent,
  buildQaInput,
  buildQaRequests,
  generateQaCards,
  qaFailureClass,
  toQaDraft,
} from '../qa/generate.ts';
import { storeQaCards } from '../qa/handler.ts';
import {
  auditDraft,
  toQaRevisionFlags,
  toRevisionFlags,
  type DraftAudit,
  type VerdictMemory,
} from './audit.ts';
import { buildVerificationRequests, verifyWithFallback } from './call.ts';
import { runRevisionLoop, type LoopResult } from './loop.ts';
import { buildVerificationRubric } from './rubric.ts';
import { VERIFICATION_PROMPT_VERSION } from './step-prompt.ts';

// Step 8, verification (docs/architecture.md §5): the creative step's copy, plus the Q&A
// step's cards when the service has one → the claim validator's findings plus one Wonder audit
// (Spark fallback) of both against a rubric built from the market profile → up to
// `max_revision_loops` loops; in each, the copy is revised through the creative step's functions
// (and settings) if it has flags, the cards through the Q&A step's (P3-03) if they have flags,
// and changed segments are audited again → every revision as a `listing_copy` or `qa_cards`
// artifact, verifier verdicts on every audited claim, and one `claim_audit` artifact with the
// remaining flags. The run always stops at Gate 2 (`claim_audit`), even when
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

/** Q&A cards during the loop; same storage rules as {@link VerificationDraft}. */
export interface QaVerificationDraft {
  readonly content: QaCardsContent;
  readonly storedId: string | null;
  readonly provisionalId: string;
}

/** What one pass audits: the copy draft and, when the service writes them, the Q&A cards. */
export interface VerificationDraftSet {
  readonly copy: VerificationDraft;
  readonly qa: QaVerificationDraft | null;
}

/** The service's Q&A step, or null when it has none (roadmap cut level 1). */
export function qaStepOf(service: ServiceDefinition): StepConfig<'qa_writer'> | null {
  const steps = service.steps.filter(
    (step): step is StepConfig<'qa_writer'> => step.agent === 'qa_writer',
  );
  if (steps.length > 1) {
    throw new NonRetryableStepError(
      `Verification expects at most one Q&A step in service ${service.id} v${service.version}; found ${steps.length}`,
    );
  }
  return steps[0] ?? null;
}

async function readInitialQa(
  db: Executor,
  runId: string,
  qaStepId: string,
): Promise<QaVerificationDraft> {
  const stored = await listArtifacts(db, runId, { kind: QA_CARDS_ARTIFACT_KIND, stepId: qaStepId });
  const [artifact] = stored;
  if (artifact === undefined || stored.length > 1) {
    throw new NonRetryableStepError(
      `Verification expects one set of Q&A cards from the Q&A step; found ${stored.length}`,
    );
  }
  const content = qaCardsContentSchema.safeParse(artifact.content);
  if (!content.success) throw new NonRetryableStepError('The Q&A cards have an invalid format');
  return { content: content.data, storedId: artifact.id, provisionalId: artifact.id };
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
function assertSameCatalog(
  content: Pick<ListingCopyContent, 'catalog'>,
  catalog: CopyFactCatalog,
  what: 'the copy was' | 'the Q&A cards were',
): void {
  const current = JSON.stringify(catalog.facts.map((fact) => [fact.id, [...fact.factIds]]));
  const written = JSON.stringify(content.catalog.map((entry) => [entry.id, entry.factIds]));
  if (current !== written) {
    throw new NonRetryableStepError(
      `The verified facts changed after ${what} written; it must be generated again`,
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
  return copyFailureClass(cause, signal) ?? qaFailureClass(cause, signal);
}

export interface VerificationLoopDeps {
  /** Called only when a model call is needed, so a run without calls never needs the API key. */
  readonly clients: () => MetaClients;
  readonly meter: StepLedger['meter'];
  readonly signal?: AbortSignal;
  /** Told about a fallback (step ID and class name only), for the step log. */
  readonly onFallback?: (stepId: string, failure: string) => void;
}

/** Q&A cards to audit with the copy: the service's Q&A step and its stored cards. */
export interface VerificationQa {
  readonly step: StepConfig<'qa_writer'>;
  readonly initial: QaVerificationDraft;
}

/**
 * The audit and revision loop over one initial draft (and its Q&A cards), without storage: the
 * handler stores the result in `commit`; the replay tests run it on recorded drafts. A loop
 * revises the copy if it has flags and the cards if they have flags (copy first); the other
 * stays as it was and its segments keep their verdicts. Revisions are numbered by their loop.
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
    /** Null or absent without a Q&A step. */
    readonly qa?: VerificationQa | null;
  },
): Promise<LoopResult<VerificationDraftSet, DraftAudit>> {
  const { step, market, creativeStep, sources, rubric } = params;
  const qa = params.qa ?? null;
  const memory: VerdictMemory = new Map();
  const callDeps = (stepId: string) => ({
    clients: deps.clients(),
    meter: deps.meter,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    onFallback: (failure: string) => deps.onFallback?.(stepId, failure),
  });

  const reviseCopy = async (
    draft: VerificationDraft,
    flags: ReturnType<typeof toRevisionFlags>,
    revision: number,
  ): Promise<VerificationDraft> => {
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
  };

  const reviseQa = async (
    qaStep: StepConfig<'qa_writer'>,
    draft: QaVerificationDraft,
    flags: ReturnType<typeof toQaRevisionFlags>,
    revision: number,
  ): Promise<QaVerificationDraft> => {
    const { photos: _photos, revision: _revision, ...qaSources } = sources;
    const input = buildQaInput({
      ...qaSources,
      revision: { draft: toQaDraft(draft.content), flags },
    });
    const generated = await generateQaCards(
      callDeps(qaStep.id),
      buildQaRequests(qaStep, market, input),
      sources.catalog,
      sources.outputLanguage,
    );
    const content = buildQaCardsContent({
      generated,
      catalog: sources.catalog,
      facts: sources.facts,
      input,
      revision,
      previousArtifactId: draft.provisionalId,
    });
    return { content, storedId: null, provisionalId: randomUUID() };
  };

  return runRevisionLoop<VerificationDraftSet, DraftAudit>({
    initial: { copy: params.initial, qa: qa?.initial ?? null },
    maxRevisionLoops: step.max_revision_loops,
    failureClass: (error) => revisionFailureClass(error, deps.signal),
    audit: (drafts) =>
      auditDraft({
        content: drafts.copy.content,
        qa: drafts.qa?.content ?? null,
        catalog: sources.catalog,
        market,
        rubric,
        memory,
        verify: (request) =>
          verifyWithFallback(callDeps(step.id), buildVerificationRequests(step, request)),
      }),
    revise: async (drafts, audit, revision) => {
      const copyFlags = toRevisionFlags(audit.flags);
      const qaFlags = toQaRevisionFlags(audit.flags, drafts.qa?.content ?? null);
      if (copyFlags.length === 0 && qaFlags.length === 0) {
        throw new Error('A flagged draft produced no revision flags');
      }
      const copy =
        copyFlags.length === 0 ? drafts.copy : await reviseCopy(drafts.copy, copyFlags, revision);
      let revisedQa = drafts.qa;
      if (qaFlags.length > 0) {
        if (qa === null || drafts.qa === null) throw new Error('Q&A flags without Q&A cards');
        revisedQa = await reviseQa(qa.step, drafts.qa, qaFlags, revision);
      }
      return { copy, qa: revisedQa };
    },
  });
}

/** The stored flags of one pass: each flag's draft artifact and claim attached. */
function storedFlags(
  audit: DraftAudit,
  ids: { readonly copy: string; readonly qa: string | null },
  claims: {
    readonly copy: ReadonlyMap<number, string>;
    readonly qa: ReadonlyMap<number, string>;
  },
): ClaimAuditFlag[] {
  return audit.flags.map((flag) => {
    const isQa = flag.variant === 'qa';
    const artifactId = isQa ? ids.qa : ids.copy;
    const claimId = (isQa ? claims.qa : claims.copy).get(flag.segmentIndex);
    if (artifactId === null || claimId === undefined) {
      throw new Error('An audited segment has no claim row');
    }
    return { ...flag, artifactId, claimId };
  });
}

export function createVerificationHandler(deps: VerificationHandlerDeps): StepHandler<'verifier'> {
  return async (ctx) => {
    const { run, step } = ctx;
    const market = deps.markets.getMarket(run.marketProfileId, run.marketProfileVersion);
    const creativeStep = creativeStepOf(ctx.service);
    const qaStep = qaStepOf(ctx.service);
    const initial = await readInitialDraft(ctx.db, run.id, creativeStep.id);
    const initialQa = qaStep === null ? null : await readInitialQa(ctx.db, run.id, qaStep.id);
    const sources = await loadCopySources(ctx.db, run, market);
    assertSameCatalog(initial.content, sources.catalog, 'the copy was');
    if (initial.content.outputLanguage !== sources.outputLanguage) {
      throw new NonRetryableStepError('The listing copy is not in the run output language');
    }
    if (initialQa !== null) {
      assertSameCatalog(initialQa.content, sources.catalog, 'the Q&A cards were');
      if (initialQa.content.outputLanguage !== sources.outputLanguage) {
        throw new NonRetryableStepError('The Q&A cards are not in the run output language');
      }
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
      {
        step,
        creativeStep,
        market,
        sources,
        rubric,
        initial,
        qa: qaStep === null || initialQa === null ? null : { step: qaStep, initial: initialQa },
      },
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
          qaFlags: audit.flags.filter((f) => f.variant === 'qa').length,
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
          const revisions = [
            ...(await listArtifacts(tx, run.id, {
              kind: LISTING_COPY_ARTIFACT_KIND,
              stepId: step.id,
            })),
            ...(await listArtifacts(tx, run.id, { kind: QA_CARDS_ARTIFACT_KIND, stepId: step.id })),
          ];
          return { artifactIds: [existing.id, ...revisions.map((r) => r.id)] };
        }

        // Revisions in loop order, each pointing at the stored artifact it revises. A draft
        // left unchanged by a loop appears in several passes and is stored once.
        const storedIdOf = new Map<string, string>();
        const revisionIds: string[] = [];
        const resolve = (previous: string | null): string | null =>
          previous === null ? null : (storedIdOf.get(previous) ?? previous);
        const storeCopy = async (draft: VerificationDraft): Promise<string> => {
          if (draft.storedId !== null) return draft.storedId;
          const known = storedIdOf.get(draft.provisionalId);
          if (known !== undefined) return known;
          const content = listingCopyContentSchema.parse({
            ...draft.content,
            previousArtifactId: resolve(draft.content.previousArtifactId),
          });
          const stored = await storeListingCopy(tx, { runId: run.id, stepId: step.id, content });
          storedIdOf.set(draft.provisionalId, stored.artifact.id);
          revisionIds.push(stored.artifact.id);
          return stored.artifact.id;
        };
        const storeQa = async (draft: QaVerificationDraft): Promise<string> => {
          if (draft.storedId !== null) return draft.storedId;
          const known = storedIdOf.get(draft.provisionalId);
          if (known !== undefined) return known;
          const content = qaCardsContentSchema.parse({
            ...draft.content,
            previousArtifactId: resolve(draft.content.previousArtifactId),
          });
          const stored = await storeQaCards(tx, { runId: run.id, stepId: step.id, content });
          storedIdOf.set(draft.provisionalId, stored.artifact.id);
          revisionIds.push(stored.artifact.id);
          return stored.artifact.id;
        };
        const passIds: { copy: string; qa: string | null }[] = [];
        for (const { draft } of result.passes) {
          const copy = await storeCopy(draft.copy);
          const qa = draft.qa === null ? null : await storeQa(draft.qa);
          passIds.push({ copy, qa });
        }

        const claimsOf = new Map<string, Awaited<ReturnType<typeof listClaims>>>();
        const claimsFor = async (artifactId: string) => {
          const cached = claimsOf.get(artifactId);
          if (cached !== undefined) return cached;
          const claims = await listClaims(tx, artifactId);
          claimsOf.set(artifactId, claims);
          return claims;
        };
        const indexMap = (claims: Awaited<ReturnType<typeof listClaims>>) =>
          new Map(claims.map((claim) => [claim.segmentIndex, claim.id]));
        const passes: ClaimAuditPass[] = [];
        for (const [i, { audit }] of result.passes.entries()) {
          const ids = passIds[i];
          if (ids === undefined) throw new Error('unreachable: a pass without stored drafts');
          const copyClaims = indexMap(await claimsFor(ids.copy));
          const qaClaims =
            ids.qa === null ? new Map<number, string>() : indexMap(await claimsFor(ids.qa));
          passes.push({
            draftArtifactId: ids.copy,
            qaDraftArtifactId: ids.qa,
            revision: i,
            segments: audit.segments,
            auditedSegments: audit.auditedSegments,
            carriedSegments: audit.carriedSegments,
            modelRun: audit.modelRun,
            flags: storedFlags(audit, ids, { copy: copyClaims, qa: qaClaims }),
            dropped: audit.dropped,
          });
        }
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
          initialQaArtifactId: initialQa?.provisionalId ?? null,
          finalQaArtifactId: last.qaDraftArtifactId,
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

        // The verifier's verdict on every claim of every audited draft; a draft that several
        // passes audited keeps the verdict of the last of them.
        for (const [i, { audit }] of result.passes.entries()) {
          const ids = passIds[i];
          if (ids === undefined) throw new Error('unreachable: a pass without stored drafts');
          const groups = [
            {
              artifactId: ids.copy,
              flags: audit.verifierFlagsByIndex,
              carried: audit.carriedIndexes,
            },
            ...(ids.qa === null
              ? []
              : [
                  {
                    artifactId: ids.qa,
                    flags: audit.qaVerifierFlagsByIndex,
                    carried: audit.qaCarriedIndexes,
                  },
                ]),
          ];
          for (const group of groups) {
            for (const claim of await claimsFor(group.artifactId)) {
              const flags = group.flags.get(claim.segmentIndex) ?? [];
              await recordVerifierVerdict(
                tx,
                claim.id,
                verifierVerdictFor(flags),
                claimVerifierDetailsSchema.parse({
                  promptVersion: VERIFICATION_PROMPT_VERSION,
                  auditArtifactId: auditArtifact.id,
                  pass: i,
                  carried: group.carried.has(claim.segmentIndex),
                  flags: flags.map((flag) => ({ ...flag })),
                }),
              );
            }
          }
        }

        const lastModel = [...passes].reverse().find((pass) => pass.modelRun !== null)?.modelRun;
        const summary = claimsAuditedPayloadSchema.parse({
          stepId: step.id,
          artifactId: auditArtifact.id,
          finalDraftArtifactId: content.finalDraftArtifactId,
          finalQaArtifactId: content.finalQaArtifactId,
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
        return { artifactIds: [auditArtifact.id, ...revisionIds] };
      },
    };
  };
}
