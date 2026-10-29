import {
  CLAIM_AUDIT_ARTIFACT_KIND,
  INTEGRITY_CHECKS_ARTIFACT_KIND,
  LISTING_COPY_ARTIFACT_KIND,
  QA_CARDS_ARTIFACT_KIND,
  QA_VARIANT,
  STAGED_IMAGE_ARTIFACT_KIND,
  claimAuditContentSchema,
  integrityChecksContentSchema,
  listingCopyContentSchema,
  qaCardsContentSchema,
  type ClaimAuditContent,
  type ClaimAuditVariant,
} from '@evidomo/shared';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { getArtifact, listArtifacts } from '../../db/repositories/artifacts.ts';
import { listClaims } from '../../db/repositories/claims.ts';
import { listFacts } from '../../db/repositories/facts.ts';
import type { Run } from '../../db/repositories/runs.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type {
  ChecklistCopySegment,
  ChecklistStagedImage,
  ClaimDecisionChoice,
  PublicationChecklistInput,
} from './evaluate.ts';

// Collects the publication checklist's inputs for a run from the database (docs/architecture.md
// §5, "Publication checklist (P3-07)"). Gate 2's decisions come from the caller already resolved,
// so this module does not depend on how Gate 2 stores them; everything else is read and checked
// here. Inconsistent inputs throw instead of producing a checklist that could pass by mistake.

/** The caller passed Gate 2 decisions that do not fit the run's stored artifacts. */
export class PublicationChecklistInputError extends Error {
  override name = 'PublicationChecklistInputError';
}

/** What the export (P3-09) passes: the run and the Gate 2 decisions it resolved. */
export interface PublicationChecklistRunInput {
  readonly run: Pick<Run, 'id' | 'marketProfileId' | 'marketProfileVersion'>;
  /**
   * The `staged_image` artifacts the operator approved at Gate 2. Each must be a
   * `finalStagedArtifactId` of the run's `integrity_checks` record.
   */
  readonly approvedStagedArtifactIds: readonly string[];
  /**
   * The Gate 2 decisions on claims of the final draft (`claim_audit.finalDraftArtifactId`) and
   * of the final Q&A cards (`finalQaArtifactId`), one per decided claim. A claim without a decision stays in the copy unchanged; a flagged claim
   * without one is unresolved.
   */
  readonly claimDecisions: readonly {
    readonly claimId: string;
    readonly choice: ClaimDecisionChoice;
  }[];
}

/** Only the disclosure is read, leniently, so a record without it fails the item visibly. */
const disclosureContentSchema = z.object({
  disclosure: z.object({ label: z.string(), visibleLabelRequired: z.boolean() }),
});

async function readClaimAudit(db: Executor, runId: string): Promise<ClaimAuditContent | null> {
  const audits = await listArtifacts(db, runId, { kind: CLAIM_AUDIT_ARTIFACT_KIND });
  const [audit] = audits;
  if (audit === undefined) return null;
  if (audits.length > 1) {
    throw new PublicationChecklistInputError(
      `The run has ${audits.length} claim audits; the checklist expects at most one`,
    );
  }
  const content = claimAuditContentSchema.safeParse(audit.content);
  if (!content.success) {
    throw new PublicationChecklistInputError('The run claim audit has an invalid format');
  }
  return content.data;
}

/** A segment of the final draft or the final Q&A cards, before decisions are applied. */
interface FinalSegment {
  readonly claimId: string;
  readonly variant: ClaimAuditVariant;
  readonly factIds: readonly string[];
  /** The Q&A card of an answer segment; null for copy. */
  readonly card: number | null;
}

async function readFinalCopySegments(
  db: Executor,
  runId: string,
  audit: ClaimAuditContent,
): Promise<FinalSegment[]> {
  const artifact = await getArtifact(db, audit.finalDraftArtifactId);
  if (artifact?.runId !== runId || artifact.kind !== LISTING_COPY_ARTIFACT_KIND) {
    throw new PublicationChecklistInputError(
      "The claim audit's final draft is not a copy of the run",
    );
  }
  const content = listingCopyContentSchema.safeParse(artifact.content);
  if (!content.success) {
    throw new PublicationChecklistInputError('The final draft has an invalid format');
  }
  const variantOf = new Map(
    content.data.variants.flatMap((variant) =>
      variant.segments.map((segment) => [segment.index, variant.kind] as const),
    ),
  );
  return withClaims(db, artifact.id, variantOf, new Map(), 'final draft');
}

/**
 * The final Q&A cards' answer segments (P3-03), variant `qa`, so a `qa` flag points at a segment
 * like a copy flag does. None when the run has no Q&A step.
 */
async function readFinalQaSegments(
  db: Executor,
  runId: string,
  audit: ClaimAuditContent,
): Promise<FinalSegment[]> {
  if (audit.finalQaArtifactId === null) return [];
  const artifact = await getArtifact(db, audit.finalQaArtifactId);
  if (artifact?.runId !== runId || artifact.kind !== QA_CARDS_ARTIFACT_KIND) {
    throw new PublicationChecklistInputError(
      "The claim audit's final Q&A cards are not Q&A cards of the run",
    );
  }
  const content = qaCardsContentSchema.safeParse(artifact.content);
  if (!content.success) {
    throw new PublicationChecklistInputError('The final Q&A cards have an invalid format');
  }
  const cards = content.data.cards.flatMap((card) =>
    card.segments.map((segment) => [segment.index, card.card] as const),
  );
  const variantOf = new Map(cards.map(([index]) => [index, QA_VARIANT] as const));
  return withClaims(db, artifact.id, variantOf, new Map(cards), 'final Q&A cards');
}

async function withClaims(
  db: Executor,
  artifactId: string,
  variantOf: ReadonlyMap<number, ClaimAuditVariant>,
  cardOf: ReadonlyMap<number, number>,
  what: string,
): Promise<FinalSegment[]> {
  const claims = await listClaims(db, artifactId);
  if (claims.length !== variantOf.size) {
    throw new PublicationChecklistInputError(
      `The ${what} have ${variantOf.size} segments but ${claims.length} claims`,
    );
  }
  return claims.map((claim) => {
    const variant = variantOf.get(claim.segmentIndex);
    if (variant === undefined) {
      throw new PublicationChecklistInputError(
        `Claim ${claim.id} has no segment ${claim.segmentIndex} in the ${what}`,
      );
    }
    return {
      claimId: claim.id,
      variant,
      factIds: claim.factIds,
      card: cardOf.get(claim.segmentIndex) ?? null,
    };
  });
}

/** The final segments (copy, then Q&A) with the operator's decisions applied. */
async function readFinalCopy(
  db: Executor,
  runId: string,
  audit: ClaimAuditContent,
  decisions: PublicationChecklistRunInput['claimDecisions'],
): Promise<ChecklistCopySegment[]> {
  const segments = [
    ...(await readFinalCopySegments(db, runId, audit)),
    ...(await readFinalQaSegments(db, runId, audit)),
  ];
  const choiceOf = new Map<string, ClaimDecisionChoice>();
  const claimIds = new Set(segments.map((segment) => segment.claimId));
  for (const { claimId, choice } of decisions) {
    if (!claimIds.has(claimId)) {
      throw new PublicationChecklistInputError(
        `Claim ${claimId} is not a segment of the final draft or Q&A cards`,
      );
    }
    if (choiceOf.has(claimId)) {
      throw new PublicationChecklistInputError(`Claim ${claimId} has more than one decision`);
    }
    choiceOf.set(claimId, choice);
  }
  // Removing any answer of a Q&A card drops the whole card at Gate 2 (P3-03), so its other
  // claims are not published either: they count as removed, whatever their own decision.
  const droppedCards = new Set(
    segments.flatMap((segment) =>
      segment.card !== null && choiceOf.get(segment.claimId) === 'remove' ? [segment.card] : [],
    ),
  );
  return segments.map(({ card, ...segment }) => ({
    ...segment,
    decision:
      card !== null && droppedCards.has(card) ? 'remove' : (choiceOf.get(segment.claimId) ?? null),
  }));
}

async function readApprovedStagedImages(
  db: Executor,
  runId: string,
  approved: readonly string[],
): Promise<ChecklistStagedImage[]> {
  if (approved.length === 0) return [];
  const approvedSet = new Set(approved);
  if (approvedSet.size !== approved.length) {
    throw new PublicationChecklistInputError('A staged image is approved more than once');
  }
  const records = await listArtifacts(db, runId, { kind: INTEGRITY_CHECKS_ARTIFACT_KIND });
  const [record] = records;
  if (record === undefined || records.length > 1) {
    throw new PublicationChecklistInputError(
      `Approved staged images need exactly one integrity record; the run has ${records.length}`,
    );
  }
  const integrity = integrityChecksContentSchema.safeParse(record.content);
  if (!integrity.success) {
    throw new PublicationChecklistInputError('The run integrity record has an invalid format');
  }
  // Manifest order, not the caller's, so the result is deterministic.
  const finals = integrity.data.photos
    .map((photo) => photo.finalStagedArtifactId)
    .filter((id) => id !== null);
  const notFinal = approved.filter((id) => !finals.includes(id));
  if (notFinal.length > 0) {
    throw new PublicationChecklistInputError(
      `Staged image ${notFinal.join(', ')} is not a final image of the integrity check`,
    );
  }

  const images: ChecklistStagedImage[] = [];
  for (const artifactId of finals.filter((id) => approvedSet.has(id))) {
    const artifact = await getArtifact(db, artifactId);
    if (artifact?.runId !== runId || artifact.kind !== STAGED_IMAGE_ARTIFACT_KIND) {
      throw new PublicationChecklistInputError(
        `Staged image ${artifactId} is not a staged image of the run`,
      );
    }
    const content = disclosureContentSchema.safeParse(artifact.content);
    images.push({ artifactId, disclosure: content.success ? content.data.disclosure : null });
  }
  return images;
}

/**
 * The checklist inputs for a run after Gate 2: the run's market profile, its verified facts,
 * the final draft's and Q&A cards' segments with the operator's decisions, the claim audit's categories and
 * remaining flags, and the approved staged images' disclosures. Pass the result to
 * `evaluatePublicationChecklist`.
 */
export async function loadPublicationChecklistInput(
  db: Executor,
  markets: Pick<DefinitionRegistry, 'getMarket'>,
  params: PublicationChecklistRunInput,
): Promise<PublicationChecklistInput> {
  const { run } = params;
  const market = markets.getMarket(run.marketProfileId, run.marketProfileVersion);
  const facts = await listFacts(db, run.id, { status: 'verified' });
  const audit = await readClaimAudit(db, run.id);

  let segments: ChecklistCopySegment[] = [];
  if (audit === null) {
    if (params.claimDecisions.length > 0) {
      throw new PublicationChecklistInputError(
        'Claim decisions were passed for a run without a claim audit',
      );
    }
  } else {
    if (audit.market.id !== market.id || audit.market.version !== market.version) {
      throw new PublicationChecklistInputError(
        `The claim audit was made for market ${audit.market.id} v${audit.market.version}, not the run's ${market.id} v${market.version}`,
      );
    }
    segments = await readFinalCopy(db, run.id, audit, params.claimDecisions);
  }

  return {
    market,
    facts,
    copy: { segments },
    claimAudit:
      audit === null
        ? null
        : {
            auditedCategories: audit.rubric.map((rule) => rule.category),
            remainingFlags: audit.remainingFlags,
          },
    stagedImages: await readApprovedStagedImages(db, run.id, params.approvedStagedArtifactIds),
  };
}
