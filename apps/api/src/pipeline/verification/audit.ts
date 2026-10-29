import {
  CLAIM_AUDIT_LIMITS,
  type ClaimAuditCategory,
  type ClaimAuditDropped,
  type ClaimAuditFlag,
  type ClaimAuditRule,
  type ClaimAuditVariant,
  type ClaimValidationReport,
  type ListingCopyContent,
  type MarketProfile,
  type QaCardsContent,
  type ReconciliationModelRun,
} from '@evidomo/shared';
import type { CopyFactCatalog } from '../creative/catalog.ts';
import type { CopyRevisionFlag } from '../creative/schema.ts';
import type { QaRevisionFlag } from '../qa/schema.ts';
import { rubricCategories } from './rubric.ts';
import {
  verificationStepInputSchema,
  type ModelAuditOutput,
  type VerificationStepInput,
} from './step-schema.ts';

// One audit of one copy draft, plus its Q&A cards when the service writes them
// (docs/architecture.md §5 Verification): the claim validator's findings, already in the drafts,
// become hard flags; changed segments go to the verifier with the rest as context; unchanged
// segments keep their earlier verdict. The model proposes flags, code decides which are valid:
// only segments sent for audit, only rubric categories, non-empty problems, no duplicates.
// Copy and Q&A segments share one verifier call; their segment indexes are per artifact, so
// every lookup is keyed by the artifact group (`copy` or `qa`) as well.

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

const ID_PREFIX: Readonly<Record<ClaimAuditVariant, string>> = {
  portal: 'P',
  social: 'S',
  qa: 'Q',
};

/** One segment of a draft, addressed both ways. */
export interface AuditSegment {
  readonly variant: ClaimAuditVariant;
  /** 0-based position within the variant (the revision flag's `segment`). */
  readonly segment: number;
  /** `segment.index` in its artifact, `claims.segment_index`. */
  readonly segmentIndex: number;
  /** The paragraph for copy; the card for Q&A. */
  readonly paragraph: number;
  readonly text: string;
  readonly catalogIds: readonly string[];
  /** The card's question for Q&A segments (context for the verifier), else null. */
  readonly question: string | null;
}

/** Which artifact a segment belongs to: the listing copy or the Q&A cards. */
export type AuditGroup = 'copy' | 'qa';

export function auditGroup(variant: ClaimAuditVariant): AuditGroup {
  return variant === 'qa' ? 'qa' : 'copy';
}

/** A segment's identity within one draft set: its group and its index in that artifact. */
export function groupKey(segment: Pick<AuditSegment, 'variant' | 'segmentIndex'>): string {
  return `${auditGroup(segment.variant)}:${segment.segmentIndex}`;
}

function compareSegments(a: AuditSegment, b: AuditSegment): number {
  const group = Number(a.variant === 'qa') - Number(b.variant === 'qa');
  return group !== 0 ? group : a.segmentIndex - b.segmentIndex;
}

/** A flag before it is stored: the claim and draft artifact IDs are attached at commit. */
export type DraftFlag = Omit<ClaimAuditFlag, 'artifactId' | 'claimId'>;

/** A verifier flag as it is carried to an unchanged segment of a later draft. */
export interface CarriedFlag {
  readonly category: ClaimAuditCategory;
  readonly problem: string;
  readonly suggestion: string | null;
}

/**
 * Verifier verdicts by segment content (variant, text, and citations): a segment that a
 * revision left unchanged keeps its verdict instead of being sent to the model again.
 */
export type VerdictMemory = Map<string, readonly CarriedFlag[]>;

export function segmentKey(
  segment: Pick<AuditSegment, 'variant' | 'text' | 'catalogIds' | 'question'>,
): string {
  const ids = [...segment.catalogIds].sort();
  // A Q&A answer is read with its question: a changed question is a changed segment.
  return JSON.stringify(
    segment.question === null
      ? [segment.variant, segment.text, ids]
      : [segment.variant, segment.text, ids, segment.question],
  );
}

export function auditSegmentId(variant: ClaimAuditVariant, position: number): string {
  return `${ID_PREFIX[variant]}${String(position + 1).padStart(2, '0')}`;
}

/** The draft's segments in artifact order, with their position within the variant. */
export function draftSegments(content: ListingCopyContent): AuditSegment[] {
  return content.variants.flatMap((variant) =>
    variant.segments.map((segment, position) => ({
      variant: variant.kind,
      segment: position,
      segmentIndex: segment.index,
      paragraph: segment.paragraph,
      text: segment.text,
      catalogIds: segment.catalogIds,
      question: null,
    })),
  );
}

/**
 * The Q&A cards' answer segments in artifact order: variant `qa`, the card as paragraph, and
 * the position within the variant equal to the segment index (`Q01…`).
 */
export function qaSegments(content: QaCardsContent): AuditSegment[] {
  return content.cards.flatMap((card) =>
    card.segments.map((segment) => ({
      variant: 'qa' as const,
      segment: segment.index,
      segmentIndex: segment.index,
      paragraph: card.card,
      text: segment.text,
      catalogIds: segment.catalogIds,
      question: card.question,
    })),
  );
}

function findingFlags(
  report: ClaimValidationReport,
  segments: readonly AuditSegment[],
): DraftFlag[] {
  const byIndex = new Map(segments.map((s) => [s.segmentIndex, s]));
  return report.findings.map((finding) => {
    const segment = byIndex.get(finding.segmentIndex);
    if (segment === undefined || segment.variant !== finding.variant) {
      // The content schemas guarantee this; reaching it means the content was not parsed.
      throw new Error('A validator finding points at no segment of its draft');
    }
    return {
      source: 'validator',
      category: 'claim_support',
      code: finding.code,
      variant: segment.variant,
      segment: segment.segment,
      segmentIndex: segment.segmentIndex,
      problem: finding.detail,
      suggestion: null,
      carried: false,
    };
  });
}

/** The claim validator's findings in the draft as hard flags (`claim_support`, never carried). */
export function validatorFlags(content: ListingCopyContent): DraftFlag[] {
  return findingFlags(content.validation, draftSegments(content));
}

/** The same for the Q&A cards' answer segments. */
export function qaValidatorFlags(content: QaCardsContent): DraftFlag[] {
  return findingFlags(content.validation, qaSegments(content));
}

export interface VerificationRequestInput {
  readonly input: VerificationStepInput;
  /** Segment IDs sent with `audit: true` (the output schema's enum); may be empty. */
  readonly auditIds: readonly string[];
  readonly categories: readonly ClaimAuditCategory[];
  readonly segmentsById: ReadonlyMap<string, AuditSegment>;
  /** Unchanged segments and the verifier flags they keep. */
  readonly carried: ReadonlyMap<string, readonly CarriedFlag[]>;
}

/**
 * The verifier's input for one draft (and its Q&A cards). Facts are the catalog entries the
 * texts cite (in catalog order, so the request is stable for replay); every segment is sent so
 * the model reads each in context, but only segments without a remembered verdict are marked for
 * audit. Without Q&A cards the input is exactly the P3-06 input.
 */
export function buildVerificationInput(params: {
  readonly content: ListingCopyContent;
  readonly qa?: QaCardsContent | null;
  readonly catalog: CopyFactCatalog;
  readonly market: MarketProfile;
  readonly rubric: readonly ClaimAuditRule[];
  readonly memory: VerdictMemory;
}): VerificationRequestInput {
  const { content, catalog, market, rubric, memory } = params;
  const qa = params.qa ?? null;
  const name = languageNames.of(content.outputLanguage);
  if (name === undefined) throw new Error(`Unknown language "${content.outputLanguage}"`);
  const segments = [...draftSegments(content), ...(qa === null ? [] : qaSegments(qa))];
  const cited = new Set(segments.flatMap((segment) => segment.catalogIds));
  const segmentsById = new Map<string, AuditSegment>();
  const carried = new Map<string, readonly CarriedFlag[]>();
  const auditIds: string[] = [];
  const variants: ClaimAuditVariant[] = [
    ...content.variants.map((variant) => variant.kind),
    ...(qa === null ? [] : ['qa' as const]),
  ];
  const copy = variants.map((variant) => ({
    variant,
    ...(variant === 'qa' && qa !== null
      ? { questions: qa.cards.map((card) => card.question) }
      : {}),
    segments: segments
      .filter((segment) => segment.variant === variant)
      .map((segment) => {
        const id = auditSegmentId(segment.variant, segment.segment);
        segmentsById.set(id, segment);
        const remembered = memory.get(segmentKey(segment));
        if (remembered === undefined) auditIds.push(id);
        else carried.set(id, remembered);
        return {
          id,
          paragraph: segment.paragraph,
          text: segment.text,
          factIds: [...segment.catalogIds],
          audit: remembered === undefined,
        };
      }),
  }));
  const input = verificationStepInputSchema.parse({
    language: { code: content.outputLanguage, name },
    market: {
      id: market.id,
      currency: market.currency ?? null,
      units: { area: market.units.area, volume: market.units.volume ?? null },
      areaBases: market.area_bases.map((basis) => ({ id: basis.id, label: basis.label })),
    },
    rubric: rubric.map((rule) => ({ category: rule.category, rule: rule.rule })),
    facts: catalog.facts
      .filter((fact) => cited.has(fact.id))
      .map((fact) => ({
        id: fact.id,
        key: fact.key,
        label: fact.label,
        value: fact.value,
        unit: fact.unit,
        basis: fact.basis,
        presence: fact.presence,
        seenIn: [...fact.seenIn],
      })),
    copy,
  } satisfies VerificationStepInput);
  return { input, auditIds, categories: rubricCategories(rubric), segmentsById, carried };
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

export interface CheckedVerifierFlags {
  /** Valid model flags in segment order, then the model's order. */
  readonly flags: readonly (CarriedFlag & { readonly segment: AuditSegment })[];
  readonly dropped: ClaimAuditDropped;
}

/** Code's check of the model's flags; nothing the model returns is trusted as is. */
export function checkVerifierFlags(
  output: ModelAuditOutput,
  request: Pick<VerificationRequestInput, 'auditIds' | 'categories' | 'segmentsById'>,
): CheckedVerifierFlags {
  const dropped: ClaimAuditDropped = {
    unknownSegment: 0,
    notAudited: 0,
    unknownCategory: 0,
    emptyProblem: 0,
    duplicate: 0,
  };
  const audit = new Set(request.auditIds);
  const seen = new Set<string>();
  const flags: (CarriedFlag & { segment: AuditSegment })[] = [];
  for (const flag of output.flags) {
    const segment = request.segmentsById.get(flag.segment);
    if (segment === undefined) {
      dropped.unknownSegment += 1;
      continue;
    }
    if (!audit.has(flag.segment)) {
      dropped.notAudited += 1;
      continue;
    }
    const category = request.categories.find((c) => c === flag.category);
    if (category === undefined) {
      dropped.unknownCategory += 1;
      continue;
    }
    const problem = clip(flag.problem, CLAIM_AUDIT_LIMITS.problem);
    if (problem === '') {
      dropped.emptyProblem += 1;
      continue;
    }
    const key = JSON.stringify([flag.segment, category, problem]);
    if (seen.has(key)) {
      dropped.duplicate += 1;
      continue;
    }
    seen.add(key);
    const suggestion =
      flag.suggestion === null ? '' : clip(flag.suggestion, CLAIM_AUDIT_LIMITS.suggestion);
    flags.push({ segment, category, problem, suggestion: suggestion === '' ? null : suggestion });
  }
  // Stable sort: segment order (copy, then Q&A), the model's order within a segment.
  flags.sort((a, b) => compareSegments(a.segment, b.segment));
  return { flags, dropped };
}

/** The verifier's answer for one request, with the model that produced it. */
export interface VerifierAnswer {
  readonly output: ModelAuditOutput;
  readonly modelRun: ReconciliationModelRun;
}

export interface DraftAudit {
  readonly segments: number;
  readonly auditedSegments: number;
  readonly carriedSegments: number;
  readonly modelRun: ReconciliationModelRun | null;
  /** Validator flags first, then verifier flags (fresh and carried), each in segment order. */
  readonly flags: readonly DraftFlag[];
  readonly dropped: ClaimAuditDropped;
  /** The verifier's flags per copy segment (empty = supported), by claim index. */
  readonly verifierFlagsByIndex: ReadonlyMap<number, readonly CarriedFlag[]>;
  /** Copy segment indexes whose verdict was carried. */
  readonly carriedIndexes: ReadonlySet<number>;
  /** The same for the Q&A answer segments (empty without Q&A cards). */
  readonly qaVerifierFlagsByIndex: ReadonlyMap<number, readonly CarriedFlag[]>;
  readonly qaCarriedIndexes: ReadonlySet<number>;
}

const NO_DROPS: ClaimAuditDropped = {
  unknownSegment: 0,
  notAudited: 0,
  unknownCategory: 0,
  emptyProblem: 0,
  duplicate: 0,
};

/**
 * Audits one draft: the verifier is called only when some segment has no remembered verdict.
 * `memory` is updated with this draft's verdicts, so the next draft carries what is unchanged.
 */
export async function auditDraft(params: {
  readonly content: ListingCopyContent;
  readonly qa?: QaCardsContent | null;
  readonly catalog: CopyFactCatalog;
  readonly market: MarketProfile;
  readonly rubric: readonly ClaimAuditRule[];
  readonly memory: VerdictMemory;
  readonly verify: (request: VerificationRequestInput) => Promise<VerifierAnswer>;
}): Promise<DraftAudit> {
  const request = buildVerificationInput(params);
  const answer = request.auditIds.length === 0 ? null : await params.verify(request);
  const checked =
    answer === null ? { flags: [], dropped: NO_DROPS } : checkVerifierFlags(answer.output, request);

  // Keyed by group and index: copy and Q&A segment indexes both start at 0.
  const byKey = new Map<string, CarriedFlag[]>();
  const carriedKeys = new Set<string>();
  for (const segment of request.segmentsById.values()) byKey.set(groupKey(segment), []);
  for (const flag of checked.flags) {
    byKey.get(groupKey(flag.segment))?.push({
      category: flag.category,
      problem: flag.problem,
      suggestion: flag.suggestion,
    });
  }
  for (const [id, flags] of request.carried) {
    const segment = request.segmentsById.get(id);
    if (segment === undefined) continue;
    carriedKeys.add(groupKey(segment));
    byKey.set(groupKey(segment), [...flags]);
  }

  const verifierFlags: DraftFlag[] = [];
  const byGroup = { copy: new Map<number, CarriedFlag[]>(), qa: new Map<number, CarriedFlag[]>() };
  const carriedByGroup = { copy: new Set<number>(), qa: new Set<number>() };
  for (const segment of [...request.segmentsById.values()].sort(compareSegments)) {
    const key = groupKey(segment);
    const flags = byKey.get(key) ?? [];
    const group = auditGroup(segment.variant);
    byGroup[group].set(segment.segmentIndex, flags);
    if (carriedKeys.has(key)) carriedByGroup[group].add(segment.segmentIndex);
    params.memory.set(segmentKey(segment), flags);
    for (const flag of flags) {
      verifierFlags.push({
        source: 'verifier',
        category: flag.category,
        code: null,
        variant: segment.variant,
        segment: segment.segment,
        segmentIndex: segment.segmentIndex,
        problem: flag.problem,
        suggestion: flag.suggestion,
        carried: carriedKeys.has(key),
      });
    }
  }
  const qa = params.qa ?? null;
  return {
    segments: request.segmentsById.size,
    auditedSegments: request.auditIds.length,
    carriedSegments: request.carried.size,
    modelRun: answer?.modelRun ?? null,
    flags: [
      ...validatorFlags(params.content),
      ...(qa === null ? [] : qaValidatorFlags(qa)),
      ...verifierFlags,
    ],
    dropped: checked.dropped,
    verifierFlagsByIndex: byGroup.copy,
    carriedIndexes: carriedByGroup.copy,
    qaVerifierFlagsByIndex: byGroup.qa,
    qaCarriedIndexes: carriedByGroup.qa,
  };
}

function revisionProblem(flag: DraftFlag): string {
  const text =
    flag.suggestion === null
      ? flag.problem
      : `${flag.problem} Suggested rewrite: ${flag.suggestion}`;
  return clip(text, CLAIM_AUDIT_LIMITS.problem);
}

/**
 * Flags for the copy revision (P3-01's `{ variant, segment, problem }`), one per distinct
 * problem; the verifier's suggestion is appended so Spark sees the intended fix. Only listing
 * copy variants are revised here; Q&A flags go to {@link toQaRevisionFlags}.
 */
export function toRevisionFlags(flags: readonly DraftFlag[]): CopyRevisionFlag[] {
  const seen = new Set<string>();
  const revision: CopyRevisionFlag[] = [];
  for (const flag of flags) {
    if (flag.variant !== 'portal' && flag.variant !== 'social') continue;
    const problem = revisionProblem(flag);
    const key = JSON.stringify([flag.variant, flag.segment, problem]);
    if (seen.has(key)) continue;
    seen.add(key);
    revision.push({ variant: flag.variant, segment: flag.segment, problem });
  }
  return revision;
}

/**
 * Flags for the Q&A revision (P3-03's `{ card, segment, problem }`: the card and the position in
 * its answer), one per distinct problem, with the verifier's suggestion appended. Copy flags are
 * skipped; a flag outside the cards is a programming error.
 */
export function toQaRevisionFlags(
  flags: readonly DraftFlag[],
  content: QaCardsContent | null,
): QaRevisionFlag[] {
  const where = new Map<number, { card: number; segment: number }>();
  for (const card of content?.cards ?? []) {
    card.segments.forEach((segment, position) => {
      where.set(segment.index, { card: card.card, segment: position });
    });
  }
  const seen = new Set<string>();
  const revision: QaRevisionFlag[] = [];
  for (const flag of flags) {
    if (flag.variant !== 'qa') continue;
    const at = where.get(flag.segmentIndex);
    if (at === undefined) throw new Error('A Q&A flag points at no segment of the cards');
    const problem = revisionProblem(flag);
    const key = JSON.stringify([at.card, at.segment, problem]);
    if (seen.has(key)) continue;
    seen.add(key);
    revision.push({ ...at, problem });
  }
  return revision;
}
