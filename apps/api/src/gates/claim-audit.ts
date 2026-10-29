import {
  APPROVED_PACK_ARTIFACT_KIND,
  CLAIM_AUDIT_ARTIFACT_KIND,
  COPY_VARIANTS,
  INTEGRITY_CHECKS_ARTIFACT_KIND,
  LISTING_COPY_ARTIFACT_KIND,
  QA_CARDS_ARTIFACT_KIND,
  STAGED_IMAGE_ARTIFACT_KIND,
  approvedPackContentSchema,
  claimAuditContentSchema,
  claimAuditGateDecidedPayloadSchema,
  claimEditSchema,
  integrityChecksContentSchema,
  listingCopyContentSchema,
  qaCardsContentSchema,
  stagedImageContentSchema,
  type ApprovedPackContent,
  type ApprovedQaCard,
  type ClaimAuditContent,
  type ClaimAuditFlag,
  type ClaimAuditGateImage,
  type ClaimAuditGateQaCard,
  type ClaimAuditGateResponse,
  type ClaimAuditGateSegment,
  type ClaimAuditGateState,
  type ClaimAuditVariant,
  type ClaimAuditWarning,
  type ClaimEdit,
  type ClaimFinding,
  type ClaimGateDecision,
  type CopyVariantKind,
  type IntegrityAttempt,
  type IntegrityAttemptSummary,
  type IntegrityChecksContent,
  type IntegrityPhoto,
  type ListingCopyContent,
  type MarketProfile,
  type ParsedClaimDecisionRequest,
  type QaCardsContent,
  type StagedImageContent,
  type StagedImageDecisionRequest,
  type StagedImageGateDecision,
} from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import {
  getArtifact,
  insertArtifact,
  listArtifacts,
  type Artifact,
} from '../db/repositories/artifacts.ts';
import { listClaims, type Claim } from '../db/repositories/claims.ts';
import { listDecisions, upsertDecisions, type Decision } from '../db/repositories/decisions.ts';
import { listFacts, type Fact } from '../db/repositories/facts.ts';
import { appendRunEvent } from '../db/repositories/run-events.ts';
import { listCompletedRunSteps } from '../db/repositories/run-steps.ts';
import { getRunForOwner, lockRun, type Run } from '../db/repositories/runs.ts';
import type { DefinitionRegistry } from '../definitions/loader.ts';
import { isClaimLanguage } from '../pipeline/claims/numbers.ts';
import { validateClaims } from '../pipeline/claims/validator.ts';
import type { RunEngine } from '../runs/engine.ts';
import { gateFact } from './fact-conflicts.ts';

// Gate 2 (docs/architecture.md §5 "Gate 2 API (P3-08)"): the final copy draft with its remaining
// claim-audit flags and the staged images the integrity check offers, the operator's decisions on
// them, and the sign-off that releases the run into export.
//
// - One decision per flagged claim (`decisions.target_kind = 'claim'`: accept / edit / remove)
//   covers all of its flags; one per offered staged image (`'artifact'`: accept / reject).
//   Unflagged segments need no decision and are published as written.
// - Decisions can be changed while the gate is open. Nothing is applied until the approval.
// - The approval (`POST .../approve`) is the only way out of the gate, with or without items to
//   decide. It is refused while anything is open; otherwise, in one transaction under the run
//   row lock, it records the sign-off (`'artifact'` decision on the `claim_audit` artifact),
//   writes the `approved_pack` artifact export reads, appends `gate_decided`, and resumes.

const GATE = 'claim_audit';
/** `artifacts.step_id` of the approved pack: the gate, not a pipeline step. */
export const CLAIM_AUDIT_GATE_STEP_ID = `gate:${GATE}`;

export type ClaimAuditGateErrorReason =
  'run_not_found' | 'target_not_found' | 'gate_not_open' | 'decisions_pending' | 'edit_rejected';

/** An expected refusal; the router maps `reason` to the HTTP status and `ApiErrorCode`. */
export class ClaimAuditGateError extends Error {
  override name = 'ClaimAuditGateError';
  readonly reason: ClaimAuditGateErrorReason;
  /** For `edit_rejected`: the claim validator's findings on the edited text. */
  readonly findings: readonly ClaimFinding[];

  constructor(reason: ClaimAuditGateErrorReason, findings: readonly ClaimFinding[] = []) {
    super(`Gate 2 request refused: ${reason}`);
    this.reason = reason;
    this.findings = findings;
  }
}

export interface ClaimAuditGateDeps {
  readonly db: Executor;
  readonly engine: Pick<RunEngine, 'resumeAfterGate'>;
  readonly markets: Pick<DefinitionRegistry, 'getMarket'>;
}

export interface ClaimAuditGate {
  /** The gate as the run's owner sees it; `run_not_found` for anyone else. */
  get(userId: string, runId: string): Promise<ClaimAuditGateResponse>;
  /** Decides one flagged claim (all of its flags). Never resumes the run. */
  decideClaim(
    userId: string,
    runId: string,
    claimId: string,
    request: ParsedClaimDecisionRequest,
  ): Promise<ClaimAuditGateResponse>;
  /** Decides one offered staged image. Never resumes the run. */
  decideImage(
    userId: string,
    runId: string,
    artifactId: string,
    request: StagedImageDecisionRequest,
  ): Promise<ClaimAuditGateResponse>;
  /** Signs off the pack and resumes the run; `decisions_pending` while anything is open. */
  approve(userId: string, runId: string): Promise<ClaimAuditGateResponse>;
}

/** A segment of the final draft or the final Q&A cards with its `claims` row. */
interface DraftSegment {
  readonly claim: Claim;
  readonly variant: ClaimAuditVariant;
  /** `claims.segment_index` in its own artifact (copy and Q&A both start at 0). */
  readonly index: number;
  readonly position: number;
  /** The paragraph for copy; the card for Q&A. */
  readonly paragraph: number;
  readonly text: string;
  readonly factIds: readonly string[];
}

interface OfferedImage {
  readonly photo: IntegrityPhoto;
  readonly artifactId: string;
  readonly content: StagedImageContent;
}

interface LoadedGate {
  readonly auditArtifact: Artifact;
  readonly audit: ClaimAuditContent;
  /** The completed step whose `gate_after` this gate is. */
  readonly stepId: string;
  readonly released: boolean;
  readonly draft: ListingCopyContent;
  /** The final Q&A cards; null when the service has no Q&A step. */
  readonly qa: { readonly artifactId: string; readonly content: QaCardsContent } | null;
  /** Draft order: portal, then social, then the Q&A answers. */
  readonly segments: readonly DraftSegment[];
  /** Remaining flags by claim ID, in the audit's order; the keys are the flagged claims. */
  readonly flagsByClaim: ReadonlyMap<string, readonly ClaimAuditFlag[]>;
  /** Undefined when the run has no integrity record: nothing is offered then. */
  readonly integrity:
    { readonly artifactId: string; readonly content: IntegrityChecksContent } | undefined;
  readonly offered: readonly OfferedImage[];
  /** Every fact of the run (the validator reports a cited non-verified fact as such). */
  readonly facts: ReadonlyMap<string, Fact>;
  readonly claimDecisions: ReadonlyMap<string, Decision>;
  readonly imageDecisions: ReadonlyMap<string, Decision>;
  readonly approval: Decision | undefined;
  readonly approvedPackArtifactId: string | null;
}

function single(stored: readonly Artifact[], what: string, runId: string): Artifact | undefined {
  if (stored.length > 1) throw new Error(`Run ${runId} has ${stored.length} ${what} artifacts`);
  return stored[0];
}

async function loadDraft(
  db: Executor,
  run: Run,
  audit: ClaimAuditContent,
): Promise<{ draft: ListingCopyContent; segments: DraftSegment[] }> {
  const artifact = await getArtifact(db, audit.finalDraftArtifactId);
  if (artifact?.runId !== run.id || artifact.kind !== LISTING_COPY_ARTIFACT_KIND) {
    throw new Error(`Run ${run.id}: the audit's final draft is not a listing_copy of the run`);
  }
  const draft = listingCopyContentSchema.parse(artifact.content);
  const claims = new Map((await listClaims(db, artifact.id)).map((c) => [c.segmentIndex, c]));
  const segments = draft.variants.flatMap((variant) =>
    variant.segments.map((segment, position): DraftSegment => {
      const claim = claims.get(segment.index);
      if (claim === undefined) {
        throw new Error(`Run ${run.id}: segment ${segment.index} of the final draft has no claim`);
      }
      return {
        claim,
        variant: variant.kind,
        index: segment.index,
        position,
        paragraph: segment.paragraph,
        text: segment.text,
        factIds: segment.factIds,
      };
    }),
  );
  return { draft, segments };
}

async function loadQa(
  db: Executor,
  run: Run,
  audit: ClaimAuditContent,
): Promise<{ qa: LoadedGate['qa']; segments: DraftSegment[] }> {
  const artifactId = audit.finalQaArtifactId;
  if (artifactId === null) return { qa: null, segments: [] };
  const artifact = await getArtifact(db, artifactId);
  if (artifact?.runId !== run.id || artifact.kind !== QA_CARDS_ARTIFACT_KIND) {
    throw new Error(`Run ${run.id}: the audit's final Q&A cards are not qa_cards of the run`);
  }
  const content = qaCardsContentSchema.parse(artifact.content);
  const claims = new Map((await listClaims(db, artifact.id)).map((c) => [c.segmentIndex, c]));
  const segments = content.cards.flatMap((card) =>
    card.segments.map((segment): DraftSegment => {
      const claim = claims.get(segment.index);
      if (claim === undefined) {
        throw new Error(`Run ${run.id}: Q&A segment ${segment.index} has no claim`);
      }
      return {
        claim,
        variant: 'qa',
        index: segment.index,
        position: segment.index,
        paragraph: card.card,
        text: segment.text,
        factIds: segment.factIds,
      };
    }),
  );
  return { qa: { artifactId, content }, segments };
}

async function loadIntegrity(
  db: Executor,
  run: Run,
): Promise<{ integrity: LoadedGate['integrity'] | undefined; offered: OfferedImage[] }> {
  const artifact = single(
    await listArtifacts(db, run.id, { kind: INTEGRITY_CHECKS_ARTIFACT_KIND }),
    INTEGRITY_CHECKS_ARTIFACT_KIND,
    run.id,
  );
  // No integrity record: nothing may be offered (only its final images ever are).
  if (artifact === undefined) return { integrity: undefined, offered: [] };
  const content = integrityChecksContentSchema.parse(artifact.content);
  const staged = new Map(
    (await listArtifacts(db, run.id, { kind: STAGED_IMAGE_ARTIFACT_KIND })).map((a) => [a.id, a]),
  );
  const offered = content.photos.flatMap((photo): OfferedImage[] => {
    const artifactId = photo.finalStagedArtifactId;
    if (artifactId === null) return [];
    const image = staged.get(artifactId);
    if (image === undefined || image.storageKey === null) {
      throw new Error(`Run ${run.id}: final staged image ${artifactId} is missing`);
    }
    const imageContent = stagedImageContentSchema.parse(image.content);
    if (
      imageContent.original.materialId !== photo.materialId ||
      imageContent.operation.id !== photo.operationId
    ) {
      throw new Error(`Run ${run.id}: staged image ${artifactId} does not match its photo`);
    }
    return [{ photo, artifactId, content: imageContent }];
  });
  return { integrity: { artifactId: artifact.id, content }, offered };
}

async function loadGate(db: Executor, run: Run): Promise<LoadedGate | undefined> {
  const auditArtifact = single(
    await listArtifacts(db, run.id, { kind: CLAIM_AUDIT_ARTIFACT_KIND }),
    CLAIM_AUDIT_ARTIFACT_KIND,
    run.id,
  );
  if (auditArtifact === undefined) return undefined;
  const audit = claimAuditContentSchema.parse(auditArtifact.content);
  const step = (await listCompletedRunSteps(db, run.id)).find(
    (s) => s.stepId === auditArtifact.stepId,
  );
  if (step === undefined) {
    throw new Error(
      `Run ${run.id} has an audit from step ${auditArtifact.stepId}, never completed`,
    );
  }
  const loadedDraft = await loadDraft(db, run, audit);
  const { draft } = loadedDraft;
  const loadedQa = await loadQa(db, run, audit);
  const segments = [...loadedDraft.segments, ...loadedQa.segments];

  const byClaim = new Map(segments.map((segment) => [segment.claim.id, segment]));
  const flagsByClaim = new Map<string, ClaimAuditFlag[]>();
  for (const flag of audit.remainingFlags) {
    const segment = byClaim.get(flag.claimId);
    const artifactId = flag.variant === 'qa' ? audit.finalQaArtifactId : audit.finalDraftArtifactId;
    if (
      flag.artifactId !== artifactId ||
      segment?.index !== flag.segmentIndex ||
      segment.variant !== flag.variant
    ) {
      throw new Error(`Run ${run.id}: a remaining flag does not point at the final draft`);
    }
    flagsByClaim.set(flag.claimId, [...(flagsByClaim.get(flag.claimId) ?? []), flag]);
  }

  const { integrity, offered } = await loadIntegrity(db, run);
  const offeredIds = new Set(offered.map((image) => image.artifactId));
  const claimDecisions = new Map<string, Decision>();
  const imageDecisions = new Map<string, Decision>();
  let approval: Decision | undefined;
  for (const decision of await listDecisions(db, run.id, { gate: GATE })) {
    if (decision.targetKind === 'claim' && flagsByClaim.has(decision.targetId)) {
      claimDecisions.set(decision.targetId, decision);
    } else if (decision.targetKind === 'artifact' && offeredIds.has(decision.targetId)) {
      imageDecisions.set(decision.targetId, decision);
    } else if (
      decision.targetKind === 'artifact' &&
      decision.targetId === auditArtifact.id &&
      decision.choice === 'accept'
    ) {
      approval = decision;
    }
  }
  const pack = single(
    await listArtifacts(db, run.id, { kind: APPROVED_PACK_ARTIFACT_KIND }),
    APPROVED_PACK_ARTIFACT_KIND,
    run.id,
  );
  return {
    auditArtifact,
    audit,
    stepId: step.stepId,
    released: step.gateReleasedAt !== null,
    draft,
    qa: loadedQa.qa,
    segments,
    flagsByClaim,
    integrity,
    offered,
    facts: new Map((await listFacts(db, run.id)).map((fact) => [fact.id, fact])),
    claimDecisions,
    imageDecisions,
    approval,
    approvedPackArtifactId: pack?.id ?? null,
  };
}

function integrityPhotos(loaded: LoadedGate): readonly IntegrityPhoto[] {
  return loaded.integrity?.content.photos ?? [];
}

function isOpenAt(run: Run): boolean {
  return run.status === 'awaiting_gate' && run.gate === GATE;
}

function gateState(run: Run, loaded: LoadedGate | undefined): ClaimAuditGateState {
  if (loaded === undefined) return 'not_reached';
  if (loaded.released) return 'released';
  return isOpenAt(run) ? 'open' : 'suspended';
}

function editOf(decision: Decision): ClaimEdit | undefined {
  const parsed = claimEditSchema.safeParse(decision.editedValue);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A claim's decision from its row. Only the shapes this module writes count; anything else
 * (`reject`, an edit without a valid stored value) reads as open and is overwritten next time.
 */
function claimDecisionOf(row: Decision | undefined): ClaimGateDecision | null {
  if (row === undefined) return null;
  const decidedAt = row.decidedAt.toISOString();
  switch (row.choice) {
    case 'accept':
    case 'remove':
      return { choice: row.choice, decidedAt };
    case 'edit': {
      const edit = editOf(row);
      return edit === undefined ? null : { choice: 'edit', text: edit.text, decidedAt };
    }
    case 'reject':
      return null;
    default: {
      const unreachable: never = row.choice;
      throw new Error(`Unhandled decision choice ${String(unreachable)}`);
    }
  }
}

function imageDecisionOf(row: Decision | undefined): StagedImageGateDecision | null {
  if (row === undefined) return null;
  if (row.choice !== 'accept' && row.choice !== 'reject') return null;
  return { choice: row.choice, decidedAt: row.decidedAt.toISOString() };
}

/**
 * One copy segment for the warnings: its variant, claim, citations' keys, and whether it is
 * removed. Q&A answers raise no warnings: the cards are not required to mention any fact, and a
 * card whose answers are all removed is simply left out.
 */
export interface WarningSegment {
  readonly variant: CopyVariantKind;
  readonly claimId: string;
  readonly factKeys: readonly string[];
  readonly removed: boolean;
}

/**
 * Non-blocking consequences of removals, per variant in `COPY_VARIANTS` order: each market fact
 * (profile order) that a removed segment cited and no kept segment of the variant cites, then
 * `variant_empty` when every segment of a variant is removed. Mentions are citations: a fact is
 * mentioned by a segment that cites one of its stored facts.
 */
export function copyWarnings(
  segments: readonly WarningSegment[],
  market: Pick<MarketProfile, 'facts'>,
): ClaimAuditWarning[] {
  const warnings: ClaimAuditWarning[] = [];
  for (const variant of COPY_VARIANTS) {
    const own = segments.filter((segment) => segment.variant === variant);
    const removed = own.filter((segment) => segment.removed);
    if (removed.length === 0) continue;
    const kept = new Set(own.filter((s) => !s.removed).flatMap((s) => s.factKeys));
    for (const fact of market.facts) {
      if (kept.has(fact.key)) continue;
      const lost = removed.filter((segment) => segment.factKeys.includes(fact.key));
      if (lost.length === 0) continue;
      warnings.push({
        kind: 'market_fact_unmentioned',
        variant,
        factKey: fact.key,
        required: fact.required,
        removedClaimIds: lost.map((segment) => segment.claimId),
      });
    }
    if (removed.length === own.length) warnings.push({ kind: 'variant_empty', variant });
  }
  return warnings;
}

function warningsFor(
  loaded: LoadedGate,
  market: Pick<MarketProfile, 'facts'>,
): ClaimAuditWarning[] {
  return copyWarnings(
    loaded.segments.flatMap((segment) => {
      const { variant } = segment;
      if (variant === 'qa') return [];
      return [
        {
          variant,
          claimId: segment.claim.id,
          factKeys: segment.factIds.flatMap((id) => {
            const key = loaded.facts.get(id)?.key;
            return key === undefined ? [] : [key];
          }),
          removed:
            claimDecisionOf(loaded.claimDecisions.get(segment.claim.id))?.choice === 'remove',
        },
      ];
    }),
    market,
  );
}

function attemptSummary(attempt: IntegrityAttempt): IntegrityAttemptSummary {
  switch (attempt.status) {
    case 'checked':
      return {
        attempt: attempt.attempt,
        status: 'checked',
        stagedArtifactId: attempt.stagedArtifactId,
        passed: attempt.passed,
        failedClasses: [...attempt.verdict.failedClasses],
        privacyPassed: attempt.privacy.passed,
        target: null,
        reason: null,
      };
    case 'unchecked':
      return {
        attempt: attempt.attempt,
        status: 'unchecked',
        stagedArtifactId: attempt.stagedArtifactId,
        passed: false,
        failedClasses: [],
        privacyPassed: null,
        target: attempt.target,
        reason: attempt.reason,
      };
    case 'edit_failed':
      return {
        attempt: attempt.attempt,
        status: 'edit_failed',
        stagedArtifactId: null,
        passed: false,
        failedClasses: [],
        privacyPassed: null,
        target: null,
        reason: attempt.reason,
      };
    default: {
      const unreachable: never = attempt;
      throw new Error(`Unhandled integrity attempt ${JSON.stringify(unreachable)}`);
    }
  }
}

function gateImage(loaded: LoadedGate, image: OfferedImage): ClaimAuditGateImage {
  const { photo, content } = image;
  const last = photo.attempts.at(-1);
  // integrityPhotoSchema guarantees a final image comes from a passing checked last attempt.
  if (last?.status !== 'checked' || photo.outcome === 'fallback_original') {
    throw new Error(`Staged image ${image.artifactId} is final without a passing check`);
  }
  return {
    artifactId: image.artifactId,
    materialId: photo.materialId,
    operation: { id: content.operation.id, kind: content.operation.kind },
    disclosureLabel: content.disclosure.label,
    stored: { width: content.stored.width, height: content.stored.height },
    integrity: {
      outcome: photo.outcome,
      aspectRatioChange: last.verdict.aspectRatioChange,
      classes: last.verdict.classes.map((c) => ({
        label: c.label,
        originalCount: c.originalCount,
        editCount: c.editCount,
        worstMatchedIoU: c.worstMatchedIoU,
      })),
      attempts: photo.attempts.map(attemptSummary),
    },
    decision: imageDecisionOf(loaded.imageDecisions.get(image.artifactId)),
  };
}

/**
 * Q&A cards dropped at Gate 2 (decided rule, P3-03): removing any flagged answer segment drops
 * the whole card, question included. The verifier flags a question's problem on the card's
 * first answer and questions cannot be edited, so removing only that answer would still publish
 * the question; cards are optional, so dropping them fails safe.
 */
function droppedQaCards(loaded: LoadedGate): ReadonlySet<number> {
  const dropped = new Set<number>();
  for (const segment of loaded.segments) {
    if (segment.variant !== 'qa' || !loaded.flagsByClaim.has(segment.claim.id)) continue;
    if (claimDecisionOf(loaded.claimDecisions.get(segment.claim.id))?.choice === 'remove') {
      dropped.add(segment.paragraph);
    }
  }
  return dropped;
}

/** Claims of dropped Q&A cards: published nowhere, so they need no decision of their own. */
function droppedQaClaimIds(loaded: LoadedGate): ReadonlySet<string> {
  const dropped = droppedQaCards(loaded);
  return new Set(
    loaded.segments
      .filter((segment) => segment.variant === 'qa' && dropped.has(segment.paragraph))
      .map((segment) => segment.claim.id),
  );
}

function openCounts(loaded: LoadedGate): { openClaims: number; openImages: number } {
  if (loaded.released) return { openClaims: 0, openImages: 0 };
  const dropped = droppedQaClaimIds(loaded);
  return {
    openClaims: [...loaded.flagsByClaim.keys()].filter(
      (id) => !dropped.has(id) && claimDecisionOf(loaded.claimDecisions.get(id)) === null,
    ).length,
    openImages: loaded.offered.filter(
      (image) => imageDecisionOf(loaded.imageDecisions.get(image.artifactId)) === null,
    ).length,
  };
}

function buildResponse(
  run: Run,
  loaded: LoadedGate | undefined,
  markets: Pick<DefinitionRegistry, 'getMarket'>,
): ClaimAuditGateResponse {
  if (loaded === undefined) {
    return {
      runId: run.id,
      runStatus: run.status,
      state: 'not_reached',
      claimAuditArtifactId: null,
      finalDraftArtifactId: null,
      finalQaArtifactId: null,
      integrityChecksArtifactId: null,
      approvedPackArtifactId: null,
      outputLanguage: null,
      stopReason: null,
      passes: [],
      counts: { flaggedClaims: 0, openClaims: 0, offeredImages: 0, openImages: 0 },
      openCount: 0,
      approval: null,
      variants: [],
      qaCards: [],
      facts: [],
      images: [],
      integrityFallbacks: [],
      warnings: [],
    };
  }
  const { openClaims, openImages } = openCounts(loaded);
  const gateSegment = (segment: DraftSegment): ClaimAuditGateSegment => ({
    claimId: segment.claim.id,
    index: segment.index,
    position: segment.position,
    paragraph: segment.paragraph,
    text: segment.text,
    factIds: [...segment.factIds],
    validatorResult: segment.claim.validatorResult,
    verifierVerdict: segment.claim.verifierVerdict,
    flags: (loaded.flagsByClaim.get(segment.claim.id) ?? []).map((flag) => ({
      source: flag.source,
      category: flag.category,
      code: flag.code,
      problem: flag.problem,
      suggestion: flag.suggestion,
      carried: flag.carried,
    })),
    decision: claimDecisionOf(loaded.claimDecisions.get(segment.claim.id)),
  });
  const variants = COPY_VARIANTS.map((kind) => ({
    kind,
    segments: loaded.segments.filter((segment) => segment.variant === kind).map(gateSegment),
  }));
  const qaSegments = loaded.segments.filter((segment) => segment.variant === 'qa');
  const droppedCards = droppedQaCards(loaded);
  const qaCards = (loaded.qa?.content.cards ?? []).map((card): ClaimAuditGateQaCard => ({
    card: card.card,
    question: card.question,
    dropped: droppedCards.has(card.card),
    segments: qaSegments.filter((segment) => segment.paragraph === card.card).map(gateSegment),
  }));
  const cited = new Set(loaded.segments.flatMap((segment) => segment.factIds));
  return {
    runId: run.id,
    runStatus: run.status,
    state: gateState(run, loaded),
    claimAuditArtifactId: loaded.auditArtifact.id,
    finalDraftArtifactId: loaded.audit.finalDraftArtifactId,
    finalQaArtifactId: loaded.audit.finalQaArtifactId,
    integrityChecksArtifactId: loaded.integrity?.artifactId ?? null,
    approvedPackArtifactId: loaded.approvedPackArtifactId,
    outputLanguage: loaded.audit.outputLanguage,
    stopReason: loaded.audit.stopReason,
    passes: loaded.audit.passes.map((pass) => ({
      draftArtifactId: pass.draftArtifactId,
      revision: pass.revision,
      flagCount: pass.flags.length,
      auditedSegments: pass.auditedSegments,
      carriedSegments: pass.carriedSegments,
    })),
    counts: {
      flaggedClaims: loaded.flagsByClaim.size,
      openClaims,
      offeredImages: loaded.offered.length,
      openImages,
    },
    openCount: openClaims + openImages,
    approval:
      loaded.approval === undefined
        ? null
        : {
            decidedBy: loaded.approval.decidedBy,
            decidedAt: loaded.approval.decidedAt.toISOString(),
          },
    variants,
    qaCards,
    facts: [...loaded.facts.values()].filter((fact) => cited.has(fact.id)).map(gateFact),
    images: loaded.offered.map((image) => gateImage(loaded, image)),
    integrityFallbacks: integrityPhotos(loaded)
      .filter((photo) => photo.outcome === 'fallback_original')
      .map((photo) => ({
        materialId: photo.materialId,
        operationId: photo.operationId,
        attempts: photo.attempts.map(attemptSummary),
      })),
    warnings: warningsFor(loaded, marketOf(run, markets)),
  };
}

function marketOf(run: Run, markets: Pick<DefinitionRegistry, 'getMarket'>): MarketProfile {
  return markets.getMarket(run.marketProfileId, run.marketProfileVersion);
}

/** The edit as stored: the text must pass the claim validator against the claim's citations. */
function validatedEdit(loaded: LoadedGate, segment: DraftSegment, text: string): ClaimEdit {
  const language = loaded.draft.outputLanguage;
  // buildCopyInput refuses other languages before any copy exists.
  if (!isClaimLanguage(language)) throw new Error(`No claim rules for language ${language}`);
  const validation = validateClaims({
    language,
    segments: [
      { variant: segment.variant, segmentIndex: segment.index, text, factIds: segment.factIds },
    ],
    facts: [...loaded.facts.values()],
  });
  if (validation.result === 'fail') {
    throw new ClaimAuditGateError('edit_rejected', validation.findings);
  }
  return claimEditSchema.parse({ text, validation });
}

type ApprovedSegment = ApprovedPackContent['variants'][number]['segments'][number];
type SegmentOrigin = ApprovedSegment['origin'];

/** The approved copy, Q&A cards, and image selection, from the final drafts and the decisions. */
function composeApprovedPack(
  loaded: LoadedGate,
  approval: Decision,
  warnings: readonly ClaimAuditWarning[],
): ApprovedPackContent {
  const removedClaimIds: string[] = [];
  /** The published text and its origin, or null when the segment is removed. */
  const publish = (segment: DraftSegment): { text: string; origin: SegmentOrigin } | null => {
    if (!loaded.flagsByClaim.has(segment.claim.id)) {
      return { text: segment.text, origin: 'unflagged' };
    }
    const decision = claimDecisionOf(loaded.claimDecisions.get(segment.claim.id));
    switch (decision?.choice) {
      case 'accept':
        return { text: segment.text, origin: 'accepted' };
      case 'edit':
        return { text: decision.text, origin: 'edited' };
      case 'remove':
        removedClaimIds.push(segment.claim.id);
        return null;
      case undefined:
        throw new Error(`Claim ${segment.claim.id} is not decided`);
      default: {
        const unreachable: never = decision;
        throw new Error(`Unhandled claim decision ${JSON.stringify(unreachable)}`);
      }
    }
  };
  const variants = COPY_VARIANTS.map((kind) => ({
    kind,
    segments: loaded.segments
      .filter((segment) => segment.variant === kind)
      .flatMap((segment): ApprovedSegment[] => {
        const published = publish(segment);
        if (published === null) return [];
        return [
          {
            claimId: segment.claim.id,
            index: segment.index,
            paragraph: segment.paragraph,
            text: published.text,
            factIds: [...segment.factIds],
            origin: published.origin,
          },
        ];
      }),
  }));
  const qaSegments = loaded.segments.filter((segment) => segment.variant === 'qa');
  const droppedCards = droppedQaCards(loaded);
  const qaCards = (loaded.qa?.content.cards ?? []).flatMap((card): ApprovedQaCard[] => {
    if (droppedCards.has(card.card)) {
      // Every claim of a dropped card is removed, decided or not (see droppedQaCards).
      for (const segment of qaSegments) {
        if (segment.paragraph === card.card) removedClaimIds.push(segment.claim.id);
      }
      return [];
    }
    const segments = qaSegments
      .filter((segment) => segment.paragraph === card.card)
      .flatMap((segment) => {
        const published = publish(segment);
        if (published === null) return [];
        return [
          {
            claimId: segment.claim.id,
            index: segment.index,
            text: published.text,
            factIds: [...segment.factIds],
            origin: published.origin,
          },
        ];
      });
    return [{ card: card.card, question: card.question, segments }];
  });
  const offeredByPhoto = new Map(loaded.offered.map((image) => [image.photo, image]));
  const images = integrityPhotos(loaded).map((photo) => {
    const offered = offeredByPhoto.get(photo);
    const decision =
      offered === undefined ? null : imageDecisionOf(loaded.imageDecisions.get(offered.artifactId));
    if (offered !== undefined && decision === null) {
      throw new Error(`Staged image ${offered.artifactId} is not decided`);
    }
    return {
      materialId: photo.materialId,
      operationId: photo.operationId,
      integrityOutcome: photo.outcome,
      offeredArtifactId: offered?.artifactId ?? null,
      decision: decision?.choice ?? null,
      publishedArtifactId: decision?.choice === 'accept' ? (offered?.artifactId ?? null) : null,
    };
  });
  return approvedPackContentSchema.parse({
    schemaVersion: 1,
    claimAuditArtifactId: loaded.auditArtifact.id,
    finalDraftArtifactId: loaded.audit.finalDraftArtifactId,
    finalQaArtifactId: loaded.audit.finalQaArtifactId,
    integrityChecksArtifactId: loaded.integrity?.artifactId ?? null,
    outputLanguage: loaded.draft.outputLanguage,
    variants,
    qaCards,
    removedClaimIds,
    images,
    warnings: [...warnings],
    approvedBy: approval.decidedBy,
    approvedAt: approval.decidedAt.toISOString(),
  } satisfies ApprovedPackContent);
}

function countChoices(pack: ApprovedPackContent, origin: 'accepted' | 'edited'): number {
  return [
    ...pack.variants.flatMap((v) => v.segments),
    ...pack.qaCards.flatMap((card) => card.segments),
  ].filter((s) => s.origin === origin).length;
}

export function createClaimAuditGate(deps: ClaimAuditGateDeps): ClaimAuditGate {
  const { db, engine, markets } = deps;

  /**
   * Runs `body` in one transaction, after the ownership check, under the run row lock (the
   * engine's lock order), with the gate open: every write on this gate serializes with the
   * others and with the engine.
   */
  async function withOpenGate<T>(
    userId: string,
    runId: string,
    body: (tx: Executor, run: Run, loaded: LoadedGate) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      if ((await getRunForOwner(tx, runId, userId)) === undefined) {
        throw new ClaimAuditGateError('run_not_found');
      }
      const run = await lockRun(tx, runId);
      if (run === undefined) throw new ClaimAuditGateError('run_not_found');
      if (!isOpenAt(run)) throw new ClaimAuditGateError('gate_not_open');
      const loaded = await loadGate(tx, run);
      if (loaded === undefined) {
        throw new Error(`Run ${run.id} awaits ${GATE} without a claim_audit artifact`);
      }
      if (loaded.released) throw new ClaimAuditGateError('gate_not_open');
      return body(tx, run, loaded);
    });
  }

  async function respond(tx: Executor, run: Run): Promise<ClaimAuditGateResponse> {
    return buildResponse(run, await loadGate(tx, run), markets);
  }

  return {
    async get(userId, runId) {
      const run = await getRunForOwner(db, runId, userId);
      if (run === undefined) throw new ClaimAuditGateError('run_not_found');
      return buildResponse(run, await loadGate(db, run), markets);
    },

    async decideClaim(userId, runId, claimId, request) {
      return withOpenGate(userId, runId, async (tx, run, loaded) => {
        const segment = loaded.segments.find((s) => s.claim.id === claimId);
        // Only flagged claims are decided; unflagged ones are published as written.
        if (segment === undefined || !loaded.flagsByClaim.has(claimId)) {
          throw new ClaimAuditGateError('target_not_found');
        }
        const current = claimDecisionOf(loaded.claimDecisions.get(claimId));
        const base = {
          runId: run.id,
          gate: GATE,
          targetKind: 'claim',
          targetId: claimId,
          decidedBy: userId,
        } as const;
        if (request.choice === 'edit') {
          const edit = validatedEdit(loaded, segment, request.text);
          if (current?.choice !== 'edit' || current.text !== edit.text) {
            await upsertDecisions(tx, [{ ...base, choice: 'edit', editedValue: edit }]);
          }
        } else if (current?.choice !== request.choice) {
          await upsertDecisions(tx, [{ ...base, choice: request.choice }]);
        }
        return respond(tx, run);
      });
    },

    async decideImage(userId, runId, artifactId, request) {
      return withOpenGate(userId, runId, async (tx, run, loaded) => {
        if (!loaded.offered.some((image) => image.artifactId === artifactId)) {
          throw new ClaimAuditGateError('target_not_found');
        }
        if (imageDecisionOf(loaded.imageDecisions.get(artifactId))?.choice !== request.choice) {
          await upsertDecisions(tx, [
            {
              runId: run.id,
              gate: GATE,
              targetKind: 'artifact',
              targetId: artifactId,
              decidedBy: userId,
              choice: request.choice,
            },
          ]);
        }
        return respond(tx, run);
      });
    },

    async approve(userId, runId) {
      return withOpenGate(userId, runId, async (tx, run, loaded) => {
        const { openClaims, openImages } = openCounts(loaded);
        if (openClaims + openImages > 0) throw new ClaimAuditGateError('decisions_pending');

        const [approval] = await upsertDecisions(tx, [
          {
            runId: run.id,
            gate: GATE,
            targetKind: 'artifact',
            targetId: loaded.auditArtifact.id,
            decidedBy: userId,
            choice: 'accept',
          },
        ]);
        if (approval === undefined) throw new Error(`Run ${run.id}: approval was not recorded`);
        const warnings = warningsFor(loaded, marketOf(run, markets));
        const pack = composeApprovedPack(loaded, approval, warnings);
        const packArtifact = await insertArtifact(tx, {
          runId: run.id,
          stepId: CLAIM_AUDIT_GATE_STEP_ID,
          kind: APPROVED_PACK_ARTIFACT_KIND,
          content: pack,
        });
        await appendRunEvent(tx, run.id, {
          type: 'gate_decided',
          payload: claimAuditGateDecidedPayloadSchema.parse({
            gate: GATE,
            stepId: loaded.stepId,
            approvedPackArtifactId: packArtifact.id,
            flaggedClaimCount: loaded.flagsByClaim.size,
            acceptedClaimCount: countChoices(pack, 'accepted'),
            editedClaimCount: countChoices(pack, 'edited'),
            removedClaimCount: pack.removedClaimIds.length,
            offeredImageCount: loaded.offered.length,
            acceptedImageCount: pack.images.filter((i) => i.decision === 'accept').length,
            rejectedImageCount: pack.images.filter((i) => i.decision === 'reject').length,
            warningCount: warnings.length,
          }),
        });
        await engine.resumeAfterGate(run.id, { gate: GATE, tx });
        const after = await lockRun(tx, run.id);
        if (after === undefined) throw new Error(`Run ${run.id} vanished while resuming`);
        return respond(tx, after);
      });
    },
  };
}
