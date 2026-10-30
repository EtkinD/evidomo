import {
  claimAuditGateResponseSchema,
  type ClaimAuditGateResponse,
  type ClaimAuditWarning,
} from '@evidomo/shared';
import { MASK_ID, MATERIAL_ID, RUN_ID, TRANSCRIPT_ID } from './gate-fixtures';

export const ARTIFACT_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const DRAFT_ID = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const QA_ID = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
const INTEGRITY_ID = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
export const STAGED_ID = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
const STAGED_MATERIAL_ID = 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6';
export const DECIDED_AT = '2026-10-29T10:05:00.000Z';

/** Claim IDs, named by what the segment says. */
export const CLAIM = {
  area: 'c0000000-0000-4000-8000-000000000001',
  rooms: 'c0000000-0000-4000-8000-000000000002',
  young: 'c0000000-0000-4000-8000-000000000003',
  socialPlain: 'c0000000-0000-4000-8000-000000000004',
  best: 'c0000000-0000-4000-8000-000000000005',
  qaGain: 'c0000000-0000-4000-8000-000000000006',
  qaGainTwo: 'c0000000-0000-4000-8000-000000000007',
  qaSize: 'c0000000-0000-4000-8000-000000000008',
} as const;

/** The fact IDs the draft cites. */
export const CFACT = {
  areaForm: 'f0000000-0000-4000-8000-000000000001',
  areaTurn: 'f0000000-0000-4000-8000-000000000002',
  roomsPhoto: 'f0000000-0000-4000-8000-000000000003',
  heating: 'f0000000-0000-4000-8000-000000000004',
} as const;

export const TEXT = {
  area: 'The flat has 92 m² of living area.',
  rooms: 'It has 4 rooms that are bright and quiet.',
  young: 'Perfect for young professionals.',
  socialPlain: 'Four rooms, one calm street.',
  best: 'The best flat in the city.',
  qaGain: 'It will gain value every year.',
  qaGainTwo: 'Prices here only go up.',
  qaSize: 'The living area is 92 m².',
} as const;

const flag = (category: string, problem: string, suggestion: string | null = null) => ({
  source: 'verifier',
  category,
  code: null,
  problem,
  suggestion,
  carried: false,
});

const segment = (
  claimId: string,
  index: number,
  paragraph: number,
  text: string,
  factIds: string[],
  flags: unknown[] = [],
  decision: unknown = null,
) => ({
  claimId,
  index,
  position: index,
  paragraph,
  text,
  factIds,
  validatorResult: 'pass',
  verifierVerdict: flags.length === 0 ? 'supported' : 'flagged',
  flags,
  decision,
});

const facts = [
  {
    id: CFACT.areaForm,
    key: 'living_area',
    value: 92,
    unit: 'm2',
    basis: 'wohnflaeche',
    status: 'verified',
    assertion: 'stated',
    source: { kind: 'form', field: 'living_area' },
  },
  {
    id: CFACT.areaTurn,
    key: 'living_area',
    value: 92,
    unit: 'm2',
    basis: 'wohnflaeche',
    status: 'verified',
    assertion: 'stated',
    source: {
      kind: 'transcript_turn',
      transcriptArtifactId: TRANSCRIPT_ID,
      turnIndex: 3,
      startMs: 83_400,
      endMs: 91_600,
      quote: 'about ninety-two square metres',
    },
  },
  {
    id: CFACT.roomsPhoto,
    key: 'rooms',
    value: 4,
    unit: null,
    basis: null,
    status: 'verified',
    assertion: 'stated',
    source: {
      kind: 'photo_region',
      materialId: MATERIAL_ID,
      region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      maskArtifactId: MASK_ID,
    },
  },
  {
    id: CFACT.heating,
    key: 'heating_type',
    value: 'district',
    unit: null,
    basis: null,
    status: 'verified',
    assertion: 'stated',
    source: { kind: 'form', field: 'heating_type' },
  },
];

type Decisions = Record<string, unknown>;

export interface AuditOptions {
  state?: ClaimAuditGateResponse['state'];
  decisions?: Decisions;
  /** Staged image decision: `accept`, `reject`, or none. */
  image?: 'accept' | 'reject' | null;
  warnings?: ClaimAuditWarning[];
  /** Drop the staged image and the fallbacks. */
  withoutImages?: boolean;
  /** Drop the Q&A cards. */
  withoutQa?: boolean;
}

const decisionOf = (decisions: Decisions, id: string): unknown => decisions[id] ?? null;

/**
 * The Gate 2 response with seven flagged-or-not segments: one flagged claim in each of the two
 * copy variants (plus an exclusionary one), two Q&A cards, and one staged image.
 */
export function auditGate(options: AuditOptions = {}): ClaimAuditGateResponse {
  const state = options.state ?? 'open';
  const decisions = options.decisions ?? {};
  const d = (id: string) => decisionOf(decisions, id);
  const reached = state !== 'not_reached';
  const flaggedIds = [CLAIM.rooms, CLAIM.young, CLAIM.best, CLAIM.qaGain, CLAIM.qaGainTwo];
  const qaDropped =
    decisions[CLAIM.qaGain] !== undefined
      ? (decisions[CLAIM.qaGain] as { choice: string }).choice === 'remove'
      : decisions[CLAIM.qaGainTwo] !== undefined &&
        (decisions[CLAIM.qaGainTwo] as { choice: string }).choice === 'remove';
  const imageDecision =
    options.image === undefined || options.image === null
      ? null
      : { choice: options.image, decidedAt: DECIDED_AT };
  const withImages = options.withoutImages !== true;
  const openClaims =
    state === 'open'
      ? flaggedIds.filter((id) => {
          if (d(id) !== null) return false;
          // The card's other flagged answer needs nothing once the card is dropped.
          if (qaDropped && (id === CLAIM.qaGain || id === CLAIM.qaGainTwo)) return false;
          return true;
        }).length
      : 0;
  const openImages = state === 'open' && withImages && imageDecision === null ? 1 : 0;

  return claimAuditGateResponseSchema.parse({
    runId: RUN_ID,
    runStatus: state === 'open' ? 'awaiting_gate' : state === 'suspended' ? 'failed' : 'running',
    state,
    claimAuditArtifactId: reached ? ARTIFACT_ID : null,
    finalDraftArtifactId: reached ? DRAFT_ID : null,
    finalQaArtifactId: reached && options.withoutQa !== true ? QA_ID : null,
    integrityChecksArtifactId: reached && withImages ? INTEGRITY_ID : null,
    approvedPackArtifactId: null,
    outputLanguage: 'en',
    stopReason: reached ? 'loop_limit' : null,
    passes: [],
    counts: {
      flaggedClaims: reached ? flaggedIds.length : 0,
      openClaims,
      offeredImages: reached && withImages ? 1 : 0,
      openImages,
    },
    openCount: openClaims + openImages,
    approval: null,
    variants: reached
      ? [
          {
            kind: 'portal',
            segments: [
              segment(CLAIM.area, 0, 0, TEXT.area, [CFACT.areaForm]),
              segment(
                CLAIM.rooms,
                1,
                0,
                TEXT.rooms,
                [CFACT.roomsPhoto, CFACT.areaTurn],
                [
                  flag(
                    'claim_support',
                    'Nothing in the facts says the rooms are quiet.',
                    'Drop the claim about quiet.',
                  ),
                ],
                d(CLAIM.rooms),
              ),
              segment(
                CLAIM.young,
                2,
                1,
                TEXT.young,
                [CFACT.heating],
                [flag('exclusionary', 'Names a preferred group of buyers.')],
                d(CLAIM.young),
              ),
            ],
          },
          {
            kind: 'social',
            segments: [
              segment(CLAIM.socialPlain, 3, 0, TEXT.socialPlain, [CFACT.roomsPhoto]),
              segment(
                CLAIM.best,
                4,
                0,
                TEXT.best,
                [CFACT.areaForm],
                [flag('unverifiable_superlative', 'A superlative nobody can verify.')],
                d(CLAIM.best),
              ),
            ],
          },
        ]
      : [],
    qaCards:
      reached && options.withoutQa !== true
        ? [
            {
              card: 0,
              question: 'Will the flat gain value?',
              dropped: qaDropped,
              segments: [
                segment(
                  CLAIM.qaGain,
                  5,
                  0,
                  TEXT.qaGain,
                  [CFACT.areaForm],
                  [flag('investment_promise', 'Promises a return on investment.')],
                  d(CLAIM.qaGain),
                ),
                segment(
                  CLAIM.qaGainTwo,
                  6,
                  0,
                  TEXT.qaGainTwo,
                  [CFACT.areaForm],
                  [flag('investment_promise', 'Promises a return on investment.')],
                  d(CLAIM.qaGainTwo),
                ),
              ],
            },
            {
              card: 1,
              question: 'How big is it?',
              dropped: false,
              segments: [segment(CLAIM.qaSize, 7, 1, TEXT.qaSize, [CFACT.areaTurn])],
            },
          ]
        : [],
    facts: reached ? facts : [],
    images:
      reached && withImages
        ? [
            {
              artifactId: STAGED_ID,
              materialId: STAGED_MATERIAL_ID,
              operation: { id: 'furnish_living_room', kind: 'furnish' },
              disclosureLabel: 'Virtually staged',
              stored: { width: 1600, height: 1200 },
              integrity: {
                outcome: 'passed_on_retry',
                aspectRatioChange: 0.012,
                classes: [
                  { label: 'window', originalCount: 2, editCount: 2, worstMatchedIoU: 0.93 },
                ],
                attempts: [
                  {
                    attempt: 1,
                    status: 'checked',
                    stagedArtifactId: null,
                    passed: false,
                    failedClasses: ['window'],
                    privacyPassed: true,
                    target: null,
                    reason: null,
                  },
                  {
                    attempt: 2,
                    status: 'checked',
                    stagedArtifactId: STAGED_ID,
                    passed: true,
                    failedClasses: [],
                    privacyPassed: true,
                    target: null,
                    reason: null,
                  },
                ],
              },
              decision: imageDecision,
            },
          ]
        : [],
    integrityFallbacks: [],
    warnings: options.warnings ?? [],
  });
}

export const decided = {
  accept: { choice: 'accept', decidedAt: DECIDED_AT },
  remove: { choice: 'remove', decidedAt: DECIDED_AT },
  edit: (text: string) => ({ choice: 'edit', text, decidedAt: DECIDED_AT }),
};

/** Every flagged claim decided as written, and the image accepted: nothing is open. */
export function allDecided(options: AuditOptions = {}): ClaimAuditGateResponse {
  return auditGate({
    ...options,
    image: 'accept',
    decisions: {
      [CLAIM.rooms]: decided.accept,
      [CLAIM.young]: decided.accept,
      [CLAIM.best]: decided.accept,
      [CLAIM.qaGain]: decided.accept,
      [CLAIM.qaGainTwo]: decided.accept,
      ...options.decisions,
    },
  });
}
