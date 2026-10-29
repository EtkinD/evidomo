import { describe, expect, it } from 'vitest';
import { apiErrorSchema } from './api-error.ts';
import {
  approvedPackContentSchema,
  claimAuditApproveRequestSchema,
  claimDecisionRequestSchema,
  claimEditSchema,
  stagedImageDecisionRequestSchema,
  type ApprovedPackContent,
} from './gate2.ts';
import { gateDecidedPayloadSchema } from './run-events.ts';

const uuid = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const other = '9d1c7f3e-0f4a-4b8e-9a51-6cc7a8e66dcf';

describe('claimDecisionRequestSchema', () => {
  it('accepts the three choices and normalizes edited whitespace like stored copy', () => {
    expect(claimDecisionRequestSchema.parse({ choice: 'accept' })).toEqual({ choice: 'accept' });
    expect(claimDecisionRequestSchema.parse({ choice: 'remove' })).toEqual({ choice: 'remove' });
    expect(
      claimDecisionRequestSchema.parse({ choice: 'edit', text: '  It has\n energy  label B. ' }),
    ).toEqual({ choice: 'edit', text: 'It has energy label B.' });
  });

  it('refuses other choices, extra fields, and empty or oversized text', () => {
    for (const body of [
      { choice: 'reject' },
      { choice: 'edit' },
      { choice: 'edit', text: ' \n ' },
      { choice: 'edit', text: 'x'.repeat(2001) },
      { choice: 'edit', text: 'ok', factIds: [uuid] },
      { choice: 'accept', text: 'ok' },
    ]) {
      expect(claimDecisionRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('other Gate 2 bodies', () => {
  it('limits images to accept or reject and the approval to an empty body', () => {
    expect(stagedImageDecisionRequestSchema.safeParse({ choice: 'reject' }).success).toBe(true);
    expect(stagedImageDecisionRequestSchema.safeParse({ choice: 'remove' }).success).toBe(false);
    expect(claimAuditApproveRequestSchema.safeParse(undefined).success).toBe(true);
    expect(claimAuditApproveRequestSchema.safeParse({}).success).toBe(true);
    expect(claimAuditApproveRequestSchema.safeParse({ force: true }).success).toBe(false);
  });

  it('stores only edits that passed the validator', () => {
    const validation = {
      rulesVersion: 1,
      language: 'en',
      result: 'pass',
      counts: { segments: 1, failedSegments: 0, numbers: 0, findings: 0 },
      findings: [],
    };
    expect(claimEditSchema.safeParse({ text: 'ok', validation }).success).toBe(true);
    const finding = {
      variant: 'portal',
      segmentIndex: 0,
      code: 'number_not_in_facts',
      token: '95',
      factId: null,
      detail: 'The number 95 is not stated by any cited fact.',
    };
    const failed = {
      ...validation,
      result: 'fail',
      counts: { segments: 1, failedSegments: 1, numbers: 1, findings: 1 },
      findings: [finding],
    };
    expect(claimEditSchema.safeParse({ text: 'ok', validation: failed }).success).toBe(false);
    expect(apiErrorSchema.parse({ error: 'claim_edit_rejected', findings: [finding] })).toEqual({
      error: 'claim_edit_rejected',
      findings: [finding],
    });
  });
});

describe('approvedPackContentSchema', () => {
  const pack: ApprovedPackContent = {
    schemaVersion: 1,
    claimAuditArtifactId: uuid,
    finalDraftArtifactId: uuid,
    integrityChecksArtifactId: null,
    outputLanguage: 'en',
    variants: [
      { kind: 'portal', segments: [] },
      { kind: 'social', segments: [] },
    ],
    removedClaimIds: [],
    images: [
      {
        materialId: uuid,
        operationId: 'furnish_bedroom',
        integrityOutcome: 'passed',
        offeredArtifactId: other,
        decision: 'accept',
        publishedArtifactId: other,
      },
    ],
    warnings: [{ kind: 'variant_empty', variant: 'social' }],
    approvedBy: uuid,
    approvedAt: '2026-10-29T10:00:00.000Z',
  };

  it('accepts a consistent pack', () => {
    expect(approvedPackContentSchema.parse(pack)).toEqual(pack);
  });

  it('publishes only accepted offered images, and keeps the variant order', () => {
    const image = pack.images[0];
    if (image === undefined) throw new Error('fixture');
    for (const images of [
      [{ ...image, decision: 'reject' as const }],
      [{ ...image, integrityOutcome: 'fallback_original' as const }],
      [{ ...image, offeredArtifactId: null, decision: null }],
    ]) {
      expect(approvedPackContentSchema.safeParse({ ...pack, images }).success).toBe(false);
    }
    expect(
      approvedPackContentSchema.safeParse({ ...pack, variants: [...pack.variants].reverse() })
        .success,
    ).toBe(false);
  });
});

describe('gate_decided for Gate 2', () => {
  it('keeps the approval event to IDs and counts', () => {
    const payload = {
      gate: 'claim_audit',
      stepId: 'verification',
      approvedPackArtifactId: uuid,
      flaggedClaimCount: 3,
      acceptedClaimCount: 1,
      editedClaimCount: 1,
      removedClaimCount: 1,
      offeredImageCount: 2,
      acceptedImageCount: 1,
      rejectedImageCount: 1,
      warningCount: 1,
    };
    expect(gateDecidedPayloadSchema.parse(payload)).toEqual(payload);
    expect(gateDecidedPayloadSchema.safeParse({ ...payload, text: 'copy' }).success).toBe(false);
    expect(gateDecidedPayloadSchema.safeParse({ ...payload, gate: 'fact_conflicts' }).success).toBe(
      false,
    );
  });
});
