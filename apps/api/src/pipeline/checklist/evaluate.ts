import {
  CLAIM_AUDIT_VARIANTS,
  PUBLICATION_CHECKLIST_RULES_VERSION,
  STAGED_IMAGE_LABEL,
  publicationChecklistResultSchema,
  type ClaimAuditCategory,
  type ClaimAuditFlag,
  type ClaimAuditVariant,
  type DecisionChoice,
  type FactSourceKind,
  type FactStatus,
  type JsonValue,
  type MarketProfile,
  type PublicationChecklistItem,
  type PublicationChecklistItemResult,
  type PublicationChecklistResult,
} from '@evidomo/shared';
import { isValidProfileValue, profileUnit } from '../extraction/normalize.ts';

// The publication checklist (docs/architecture.md §5, "Publication checklist (P3-07)"): the
// market profile's items evaluated against the pack as Gate 2 left it. Pure and deterministic:
// no database, no clock, no model. The loader (`load.ts`) collects the inputs for a run.
// Details name keys, counts, and categories only, never fact values or copy text.

/** A fact of the run as the repository returns it (only these fields are read). */
export interface ChecklistFact {
  readonly id: string;
  readonly key: string;
  readonly value: JsonValue;
  readonly unit: string | null;
  readonly basis: string | null;
  readonly status: FactStatus;
  readonly source: { readonly kind: FactSourceKind };
}

/** A Gate 2 decision on a claim (`decisions.target_kind = 'claim'`). */
export type ClaimDecisionChoice = Extract<DecisionChoice, 'accept' | 'edit' | 'remove'>;

/** One segment of the final draft, with the operator's Gate 2 decision on its claim. */
export interface ChecklistCopySegment {
  /** The `claims` row of the final draft's segment. */
  readonly claimId: string;
  readonly variant: ClaimAuditVariant;
  /** Stored fact IDs the segment cites (`claims.fact_ids`). */
  readonly factIds: readonly string[];
  /** Null when the operator made no decision (an unflagged segment, or one still open). */
  readonly decision: ClaimDecisionChoice | null;
}

/** What the run's `claim_audit` says about the final draft. */
export interface ChecklistClaimAudit {
  /** The rubric's categories: what the verifier was asked to check. */
  readonly auditedCategories: readonly ClaimAuditCategory[];
  readonly remainingFlags: readonly Pick<ClaimAuditFlag, 'category' | 'claimId'>[];
}

/** A staged image the operator approved at Gate 2, with its record's disclosure. */
export interface ChecklistStagedImage {
  readonly artifactId: string;
  readonly disclosure: { readonly label: string; readonly visibleLabelRequired: boolean } | null;
}

export interface PublicationChecklistInput {
  readonly market: MarketProfile;
  /** The run's facts; only `verified` ones count. */
  readonly facts: readonly ChecklistFact[];
  /** Every segment of the final draft, removed ones included (with `decision: 'remove'`). */
  readonly copy: { readonly segments: readonly ChecklistCopySegment[] };
  /** Null when the run has no claim audit: `no_flagged_phrasing` items then fail. */
  readonly claimAudit: ChecklistClaimAudit | null;
  /** The approved staged images only; rejected and undecided ones are not in the pack. */
  readonly stagedImages: readonly ChecklistStagedImage[];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function evaluateFactPresent(
  item: Extract<PublicationChecklistItem, { rule: 'fact_present' }>,
  input: PublicationChecklistInput,
): PublicationChecklistItemResult {
  const base = { id: item.id, label: item.label, rule: item.rule, fact: item.fact };
  const marketFact = input.market.facts.find((fact) => fact.key === item.fact);
  if (marketFact === undefined) {
    return {
      ...base,
      status: 'fail',
      detail: `"${item.fact}" is not a fact of market ${input.market.id} v${input.market.version}.`,
      factIds: [],
      citedIn: [],
    };
  }
  // Photo facts are presence evidence (a per-photo count), never a publishable value.
  const verified = input.facts.filter(
    (fact) =>
      fact.status === 'verified' && fact.key === item.fact && fact.source.kind !== 'photo_region',
  );
  const unit = profileUnit(input.market, marketFact);
  const basis = marketFact.type === 'area' ? marketFact.basis : null;
  const onMeasure = verified.filter(
    (fact) =>
      fact.unit === unit && fact.basis === basis && isValidProfileValue(marketFact, fact.value),
  );
  const factIds = onMeasure.map((fact) => fact.id);
  const cited = new Set(
    input.copy.segments
      .filter((segment) => segment.decision !== 'remove')
      .filter((segment) => segment.factIds.some((id) => factIds.includes(id)))
      .map((segment) => segment.variant),
  );
  const citedIn = CLAIM_AUDIT_VARIANTS.filter((variant) => cited.has(variant));

  if (onMeasure.length === 0) {
    const measure = [unit, basis].filter((part) => part !== null).join(', ');
    const off = verified.length;
    return {
      ...base,
      status: 'fail',
      detail:
        off > 0
          ? `No verified "${item.fact}" value on the profile measure (${measure}); ${plural(off, 'verified fact')} ${off === 1 ? 'uses' : 'use'} another unit, basis, or an invalid value.`
          : `No verified "${item.fact}" value, so the pack cannot show it.`,
      factIds,
      citedIn,
    };
  }
  // Facts are scalars, so the JSON text identifies a value exactly (no coercion: 92 ≠ "92").
  const values = new Set(onMeasure.map((fact) => JSON.stringify(fact.value)));
  if (values.size > 1) {
    return {
      ...base,
      status: 'fail',
      detail: `${values.size} different verified "${item.fact}" values; the pack must show exactly one.`,
      factIds,
      citedIn,
    };
  }
  return {
    ...base,
    status: 'pass',
    detail:
      citedIn.length > 0
        ? `Verified (${plural(onMeasure.length, 'source')}) and cited in the ${citedIn.join(' and ')} copy.`
        : `Verified (${plural(onMeasure.length, 'source')}); the copy does not cite it, the fact sheet and portal fields show it.`,
    factIds,
    citedIn,
  };
}

function isLabeled(image: ChecklistStagedImage): boolean {
  return (
    image.disclosure !== null &&
    image.disclosure.label === STAGED_IMAGE_LABEL &&
    image.disclosure.visibleLabelRequired
  );
}

function evaluateStagedImagesLabeled(
  item: Extract<PublicationChecklistItem, { rule: 'staged_images_labeled' }>,
  input: PublicationChecklistInput,
): PublicationChecklistItemResult {
  const images = [
    ...new Map(input.stagedImages.map((image) => [image.artifactId, image])).values(),
  ];
  const base = { id: item.id, label: item.label, rule: item.rule };
  const stagedArtifactIds = images.map((image) => image.artifactId);
  if (images.length === 0) {
    return {
      ...base,
      status: 'not_applicable',
      detail: 'No staged image is approved for the pack.',
      stagedArtifactIds,
      unlabeledArtifactIds: [],
    };
  }
  const unlabeledArtifactIds = images
    .filter((image) => !isLabeled(image))
    .map((image) => image.artifactId);
  if (unlabeledArtifactIds.length > 0) {
    return {
      ...base,
      status: 'fail',
      detail: `${unlabeledArtifactIds.length} of ${plural(images.length, 'approved staged image')} ${unlabeledArtifactIds.length === 1 ? 'lacks' : 'lack'} the visible "${STAGED_IMAGE_LABEL}" disclosure.`,
      stagedArtifactIds,
      unlabeledArtifactIds,
    };
  }
  return {
    ...base,
    status: 'pass',
    detail: `${images.length === 1 ? 'The approved staged image carries' : `All ${images.length} approved staged images carry`} the visible "${STAGED_IMAGE_LABEL}" label.`,
    stagedArtifactIds,
    unlabeledArtifactIds,
  };
}

function evaluateNoFlaggedPhrasing(
  item: Extract<PublicationChecklistItem, { rule: 'no_flagged_phrasing' }>,
  input: PublicationChecklistInput,
): PublicationChecklistItemResult {
  const claimLists: Record<'acceptedClaimIds' | 'editedClaimIds' | 'removedClaimIds', string[]> = {
    acceptedClaimIds: [],
    editedClaimIds: [],
    removedClaimIds: [],
  };
  const base = {
    id: item.id,
    label: item.label,
    rule: item.rule,
    category: item.category,
    ...claimLists,
  };
  const audit = input.claimAudit;
  if (audit?.auditedCategories.includes(item.category) !== true) {
    return {
      ...base,
      status: 'fail',
      detail:
        audit === null
          ? 'The copy has no claim audit, so this category was not checked.'
          : 'The claim audit did not check this category.',
      audited: false,
      unresolvedClaimIds: [],
    };
  }

  const segments = new Map(input.copy.segments.map((segment) => [segment.claimId, segment]));
  const flagged = [
    ...new Set(
      audit.remainingFlags
        .filter((flag) => flag.category === item.category)
        .map((flag) => flag.claimId),
    ),
  ];
  const unresolvedClaimIds: string[] = [];
  let outsideCopy = 0;
  for (const claimId of flagged) {
    const segment = segments.get(claimId);
    // A flag on a claim the final copy does not contain cannot be shown resolved: fail closed.
    if (segment === undefined) {
      outsideCopy += 1;
      unresolvedClaimIds.push(claimId);
      continue;
    }
    switch (segment.decision) {
      case null:
        unresolvedClaimIds.push(claimId);
        break;
      case 'accept':
        base.acceptedClaimIds.push(claimId);
        break;
      case 'edit':
        base.editedClaimIds.push(claimId);
        break;
      case 'remove':
        base.removedClaimIds.push(claimId);
        break;
      default: {
        const unreachable: never = segment.decision;
        throw new Error(`Unhandled Gate 2 decision: ${String(unreachable)}`);
      }
    }
  }

  if (unresolvedClaimIds.length > 0) {
    const undecided = unresolvedClaimIds.length - outsideCopy;
    const parts = [
      undecided > 0
        ? `${plural(undecided, 'flagged segment')} ${undecided === 1 ? 'is' : 'are'} undecided at Gate 2`
        : null,
      outsideCopy > 0
        ? `${plural(outsideCopy, 'flag')} ${outsideCopy === 1 ? 'points' : 'point'} at a segment outside the final copy`
        : null,
    ].filter((part) => part !== null);
    return {
      ...base,
      status: 'fail',
      detail: `${parts.join('; ')}.`,
      audited: true,
      unresolvedClaimIds,
    };
  }
  if (flagged.length === 0) {
    return {
      ...base,
      status: 'pass',
      detail: 'The claim audit left no flag in this category.',
      audited: true,
      unresolvedClaimIds,
    };
  }
  const decided = [
    base.acceptedClaimIds.length > 0 ? `${base.acceptedClaimIds.length} approved as written` : null,
    base.editedClaimIds.length > 0
      ? `${base.editedClaimIds.length} rewritten (not re-audited)`
      : null,
    base.removedClaimIds.length > 0 ? `${base.removedClaimIds.length} removed` : null,
  ].filter((part) => part !== null);
  return {
    ...base,
    status: 'pass',
    detail: `${plural(flagged.length, 'flagged segment')} in this category, all decided at Gate 2: ${decided.join(', ')}.`,
    audited: true,
    unresolvedClaimIds,
  };
}

function evaluateItem(
  item: PublicationChecklistItem,
  input: PublicationChecklistInput,
): PublicationChecklistItemResult {
  switch (item.rule) {
    case 'fact_present':
      return evaluateFactPresent(item, input);
    case 'staged_images_labeled':
      return evaluateStagedImagesLabeled(item, input);
    case 'no_flagged_phrasing':
      return evaluateNoFlaggedPhrasing(item, input);
    default: {
      // Unreachable for a profile that passed the loader, which rejects unknown rules at boot.
      // Anything else (an unvalidated profile) fails the whole checklist rather than skipping.
      const unknown: never = item;
      throw new Error(`Unknown publication checklist rule: ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Evaluates the market profile's publication checklist for a pack, in the profile's order.
 * `readyToPublish` is false while any item fails; a failing item does not block export (the
 * pack shows it). The result is validated against the shared schema before it is returned.
 */
export function evaluatePublicationChecklist(
  input: PublicationChecklistInput,
): PublicationChecklistResult {
  const items = input.market.publication_checklist.map((item) => evaluateItem(item, input));
  const of = (status: PublicationChecklistItemResult['status']) =>
    items.filter((item) => item.status === status).length;
  const fail = of('fail');
  return publicationChecklistResultSchema.parse({
    schemaVersion: 1,
    rulesVersion: PUBLICATION_CHECKLIST_RULES_VERSION,
    market: { id: input.market.id, version: input.market.version },
    items,
    summary: {
      readyToPublish: fail === 0,
      counts: {
        items: items.length,
        pass: of('pass'),
        fail,
        notApplicable: of('not_applicable'),
      },
    },
  } satisfies PublicationChecklistResult);
}
