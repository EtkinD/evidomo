import { describe, expect, it } from 'vitest';
import {
  claimAuditContentSchema,
  claimAuditFlagSchema,
  verifierVerdictFor,
  type ClaimAuditContent,
  type ClaimAuditFlag,
} from './claim-audit.ts';
import { claimsAuditedPayloadSchema } from './run-events.ts';

const DRAFT_0 = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const DRAFT_1 = '9a0e8a2c-5a8e-4d43-9f0e-1c1a6f6f2f10';
const CLAIM = 'c0a8012e-7d2b-4f5e-8f3a-2b1c0d9e8f7a';
const MODEL_RUN = {
  model: 'muse-wonder-1.0',
  reasoningEffort: 'low',
  maxOutputTokens: 12000,
  fallbackFrom: null,
};
const NO_DROPS = {
  unknownSegment: 0,
  notAudited: 0,
  unknownCategory: 0,
  emptyProblem: 0,
  duplicate: 0,
};

const flag: ClaimAuditFlag = {
  source: 'verifier',
  category: 'claim_support',
  code: null,
  artifactId: DRAFT_0,
  variant: 'portal',
  segment: 3,
  segmentIndex: 3,
  claimId: CLAIM,
  problem: '"included" is not stated by a cited fact.',
  suggestion: 'There is a 6 m² external storage room.',
  carried: false,
};

const audit: ClaimAuditContent = {
  schemaVersion: 1,
  promptVersion: 1,
  outputLanguage: 'en',
  market: { id: 'nl', version: 1 },
  rubric: [{ category: 'claim_support', rule: 'Say only what the cited facts say.' }],
  maxRevisionLoops: 2,
  stopReason: 'clean',
  initialDraftArtifactId: DRAFT_0,
  finalDraftArtifactId: DRAFT_1,
  initialQaArtifactId: null,
  finalQaArtifactId: null,
  passes: [
    {
      draftArtifactId: DRAFT_0,
      qaDraftArtifactId: null,
      revision: 0,
      segments: 4,
      auditedSegments: 4,
      carriedSegments: 0,
      modelRun: MODEL_RUN,
      flags: [flag],
      dropped: NO_DROPS,
    },
    {
      draftArtifactId: DRAFT_1,
      qaDraftArtifactId: null,
      revision: 1,
      segments: 4,
      auditedSegments: 1,
      carriedSegments: 3,
      modelRun: MODEL_RUN,
      flags: [],
      dropped: NO_DROPS,
    },
  ],
  remainingFlags: [],
  counts: {
    passes: 2,
    revisions: 1,
    verifierCalls: 2,
    remainingFlags: 0,
    remainingValidatorFlags: 0,
    remainingVerifierFlags: 0,
    flaggedClaims: 0,
    finalClaims: 4,
  },
  fallbackUsed: false,
};

describe('claim audit content', () => {
  it('accepts a consistent audit', () => {
    expect(claimAuditContentSchema.parse(audit)).toEqual(audit);
  });

  it('rejects counts, stop reasons, and remaining flags that do not match the passes', () => {
    const bad = (patch: Partial<ClaimAuditContent>) =>
      claimAuditContentSchema.safeParse({ ...audit, ...patch }).success;
    expect(bad({ counts: { ...audit.counts, revisions: 2 } })).toBe(false);
    expect(bad({ stopReason: 'loop_limit' })).toBe(false);
    expect(bad({ remainingFlags: [flag] })).toBe(false);
    expect(bad({ finalDraftArtifactId: DRAFT_0 })).toBe(false);
    expect(bad({ fallbackUsed: true })).toBe(false);
    expect(bad({ maxRevisionLoops: 0 })).toBe(false);
  });

  it('reads audits stored before Q&A cards existed with null Q&A drafts', () => {
    const { initialQaArtifactId: _i, finalQaArtifactId: _f, ...old } = audit;
    const parsed = claimAuditContentSchema.parse({
      ...old,
      passes: audit.passes.map(({ qaDraftArtifactId: _q, ...pass }) => pass),
    });
    expect(parsed).toEqual(audit);
  });

  it('points Q&A flags at the pass Q&A draft and copy flags at the copy draft', () => {
    const QA_0 = '0b5bd1a8-3a43-4d8a-9c55-0d8c58d4c001';
    const QA_1 = '0b5bd1a8-3a43-4d8a-9c55-0d8c58d4c002';
    const qaFlag: ClaimAuditFlag = { ...flag, variant: 'qa', artifactId: QA_0 };
    const withQa = (first: ClaimAuditFlag): ClaimAuditContent => ({
      ...audit,
      initialQaArtifactId: QA_0,
      finalQaArtifactId: QA_1,
      passes: audit.passes.map((pass, i) => ({
        ...pass,
        qaDraftArtifactId: i === 0 ? QA_0 : QA_1,
        flags: i === 0 ? [first] : [],
      })),
    });
    expect(claimAuditContentSchema.safeParse(withQa(qaFlag)).success).toBe(true);
    expect(
      claimAuditContentSchema.safeParse(withQa({ ...qaFlag, artifactId: DRAFT_0 })).success,
    ).toBe(false);
    // Every pass audits Q&A cards, or none does; the last pass names the final cards.
    const partial = withQa(qaFlag);
    expect(
      claimAuditContentSchema.safeParse({
        ...partial,
        passes: partial.passes.map((pass, i) =>
          i === 1 ? { ...pass, qaDraftArtifactId: null } : pass,
        ),
      }).success,
    ).toBe(false);
    expect(claimAuditContentSchema.safeParse({ ...partial, finalQaArtifactId: QA_0 }).success).toBe(
      false,
    );
  });

  it('requires a code exactly on validator flags, and no suggestion or carry on them', () => {
    expect(claimAuditFlagSchema.safeParse({ ...flag, code: 'number_not_in_facts' }).success).toBe(
      false,
    );
    const validator = {
      ...flag,
      source: 'validator',
      code: 'number_not_in_facts',
      suggestion: null,
    };
    expect(claimAuditFlagSchema.safeParse(validator).success).toBe(true);
    expect(claimAuditFlagSchema.safeParse({ ...validator, carried: true }).success).toBe(false);
    expect(claimAuditFlagSchema.safeParse({ ...flag, category: 'tone' }).success).toBe(false);
  });

  it('maps verifier flags to the claims verdict', () => {
    expect(verifierVerdictFor([])).toBe('supported');
    expect(verifierVerdictFor([{ category: 'exclusionary' }])).toBe('flagged');
    expect(verifierVerdictFor([{ category: 'exclusionary' }, { category: 'claim_support' }])).toBe(
      'unsupported',
    );
  });

  it('keeps the event to counts: unknown keys such as text are rejected', () => {
    const payload = {
      stepId: 'verification',
      artifactId: DRAFT_1,
      finalDraftArtifactId: DRAFT_1,
      finalQaArtifactId: null,
      passCount: 2,
      revisionCount: 1,
      verifierCallCount: 2,
      stopReason: 'clean',
      remainingFlagCount: 0,
      remainingValidatorFlagCount: 0,
      remainingVerifierFlagCount: 0,
      flaggedClaimCount: 0,
      model: 'muse-wonder-1.0',
      fallbackUsed: false,
    };
    expect(claimsAuditedPayloadSchema.parse(payload)).toEqual(payload);
    // Events appended before P3-03 have no finalQaArtifactId.
    const { finalQaArtifactId: _qa, ...old } = payload;
    expect(claimsAuditedPayloadSchema.parse(old)).toEqual(payload);
    expect(claimsAuditedPayloadSchema.safeParse({ ...payload, problem: 'x' }).success).toBe(false);
  });
});
