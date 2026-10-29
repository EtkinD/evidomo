import type {
  ClaimAuditGateResponse,
  ClaimAuditGateSegment,
  FactConflictsGateResponse,
  GateConflict,
  GateFact,
} from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import {
  decisionsFileSchema,
  planClaimAuditDecisions,
  planFactConflictDecisions,
  ScriptedDecisionError,
  type DecisionsFile,
} from './decisions.ts';

const RUN = '00000000-0000-4000-8000-000000000000';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fact(
  id: number,
  kind: 'form' | 'transcript_turn' | 'photo_region',
  value: number,
): GateFact {
  const source =
    kind === 'form'
      ? { kind, field: 'build_year' }
      : kind === 'transcript_turn'
        ? { kind, transcriptArtifactId: uuid(900), turnIndex: 1, startMs: 0, endMs: 10, quote: 'q' }
        : { kind, materialId: uuid(901), region: { x: 0, y: 0, width: 1, height: 1 } };
  return {
    id: uuid(id),
    key: 'build_year',
    value,
    unit: null,
    basis: null,
    status: 'conflicted',
    assertion: 'stated',
    source,
  };
}

function conflict(id: string, key: string, sides: readonly (readonly GateFact[])[]): GateConflict {
  return {
    id,
    key,
    kind: 'value_mismatch',
    detectedBy: ['code'],
    explanation: 'values differ',
    decision: null,
    sides: sides.map((facts) => ({
      key,
      value: typeof facts[0]?.value === 'number' ? facts[0].value : 0,
      unit: null,
      basis: null,
      factIds: facts.map((f) => f.id),
      evidenceIds: facts.map((_, i) => `C0${i + 1}`),
      sourceKinds: [...new Set(facts.map((f) => f.source.kind))],
      facts: [...facts],
    })),
  };
}

function gate1(conflicts: GateConflict[]): FactConflictsGateResponse {
  return {
    runId: RUN,
    runStatus: 'awaiting_gate',
    state: 'open',
    factSheetArtifactId: uuid(800),
    conflictsArtifactId: uuid(801),
    conflictCount: conflicts.length,
    openCount: conflicts.length,
    conflicts,
  };
}

function file(
  overrides: Partial<Record<'factConflicts' | 'claimAudit', unknown>> = {},
): DecisionsFile {
  return decisionsFileSchema.parse({
    formatVersion: 1,
    factConflicts: { default: 'accept_form_else_reject' },
    claimAudit: { claims: { default: 'remove' }, images: { default: 'accept' } },
    ...overrides,
  });
}

const buildYear = conflict('K01', 'build_year', [
  [fact(1, 'form', 1986)],
  [fact(2, 'transcript_turn', 1987)],
]);
const floor = conflict('K02', 'other:bedroom_floor', [
  [fact(3, 'transcript_turn', 1)],
  [fact(4, 'photo_region', 2)],
]);

describe('decisions file schema', () => {
  it('requires a default per section and rejects duplicate targets and unknown fields', () => {
    expect(decisionsFileSchema.safeParse({ formatVersion: 1 }).success).toBe(false);
    const duplicate = decisionsFileSchema.safeParse({
      formatVersion: 1,
      factConflicts: {
        default: 'reject',
        decisions: [
          { key: 'a', choice: 'reject' },
          { key: 'a', choice: 'reject' },
        ],
      },
      claimAudit: { claims: { default: 'remove' }, images: { default: 'accept' } },
    });
    expect(duplicate.success).toBe(false);
    const unknown = decisionsFileSchema.safeParse({
      formatVersion: 1,
      factConflicts: { default: 'reject', surprise: true },
      claimAudit: { claims: { default: 'remove' }, images: { default: 'accept' } },
    });
    expect(unknown.success).toBe(false);
  });
});

describe('planFactConflictDecisions', () => {
  it('applies listed decisions and the default to the rest', () => {
    const plan = planFactConflictDecisions(
      gate1([buildYear, floor]),
      file({
        factConflicts: {
          default: 'accept_form_else_reject',
          decisions: [
            { key: 'build_year', choice: 'accept', side: { source: 'transcript' } },
            { key: 'living_area', choice: 'reject' },
          ],
        },
      }).factConflicts,
    );
    expect(plan.decisions.map((d) => [d.conflictId, d.request, d.origin])).toEqual([
      ['K01', { choice: 'accept', factId: uuid(2) }, 'decisions_file'],
      ['K02', { choice: 'reject' }, 'default_policy'],
    ]);
    expect(plan.unused).toEqual(['fact conflict "living_area": no open conflict on this key']);
  });

  it('accepts the form side by default, or a side chosen by value', () => {
    expect(
      planFactConflictDecisions(gate1([buildYear]), file().factConflicts).decisions[0]?.request,
    ).toEqual({ choice: 'accept', factId: uuid(1) });
    const byValue = planFactConflictDecisions(
      gate1([buildYear]),
      file({
        factConflicts: {
          default: 'fail',
          decisions: [{ key: 'build_year', choice: 'accept', side: { value: 1987 } }],
        },
      }).factConflicts,
    );
    expect(byValue.decisions[0]?.label).toBe('accept side (1987)');
  });

  it('passes edits through the gate request schema', () => {
    const plan = planFactConflictDecisions(
      gate1([buildYear]),
      file({
        factConflicts: {
          default: 'fail',
          decisions: [{ key: 'build_year', choice: 'edit', value: 1988 }],
        },
      }).factConflicts,
    );
    expect(plan.decisions[0]?.request).toEqual({ choice: 'edit', value: 1988 });
  });

  it('refuses a selector that matches no side or several', () => {
    const twoTranscripts = conflict('K01', 'build_year', [
      [fact(1, 'transcript_turn', 1986)],
      [fact(2, 'transcript_turn', 1987)],
    ]);
    const decisions = file({
      factConflicts: {
        default: 'fail',
        decisions: [{ key: 'build_year', choice: 'accept', side: { source: 'transcript' } }],
      },
    }).factConflicts;
    expect(() => planFactConflictDecisions(gate1([twoTranscripts]), decisions)).toThrow(
      /2 sides hold a transcript fact/,
    );
    const noPhoto = file({
      factConflicts: {
        default: 'fail',
        decisions: [{ key: 'build_year', choice: 'accept', side: { source: 'photo' } }],
      },
    }).factConflicts;
    expect(() => planFactConflictDecisions(gate1([buildYear]), noPhoto)).toThrow(
      ScriptedDecisionError,
    );
  });

  it('stops on an unlisted conflict when the default is fail', () => {
    const decisions = file({ factConflicts: { default: 'fail' } }).factConflicts;
    expect(() => planFactConflictDecisions(gate1([floor]), decisions)).toThrow(
      /K02 \(other:bedroom_floor\) is not in the decisions file/,
    );
  });
});

function segment(position: number, flagged: boolean): ClaimAuditGateSegment {
  return {
    claimId: uuid(100 + position),
    index: position,
    position,
    paragraph: 0,
    text: `Segment ${position}.`,
    factIds: [uuid(1)],
    validatorResult: flagged ? 'fail' : 'pass',
    verifierVerdict: flagged ? 'unsupported' : 'supported',
    flags: flagged
      ? [
          {
            source: 'validator',
            category: 'claim_support',
            code: 'number_not_in_facts',
            problem: 'The number is not a cited value.',
            suggestion: null,
            carried: false,
          },
        ]
      : [],
    decision: null,
  };
}

function gate2(): ClaimAuditGateResponse {
  return {
    runId: RUN,
    runStatus: 'awaiting_gate',
    state: 'open',
    claimAuditArtifactId: uuid(700),
    finalDraftArtifactId: uuid(701),
    integrityChecksArtifactId: uuid(702),
    approvedPackArtifactId: null,
    outputLanguage: 'en',
    stopReason: 'loop_limit',
    passes: [],
    counts: { flaggedClaims: 2, openClaims: 2, offeredImages: 1, openImages: 1 },
    openCount: 3,
    approval: null,
    variants: [
      { kind: 'portal', segments: [segment(0, false), segment(1, true)] },
      { kind: 'social', segments: [segment(0, true)] },
    ],
    facts: [],
    images: [
      {
        artifactId: uuid(600),
        materialId: uuid(500),
        operation: { id: 'furnish_living_room', kind: 'furnish' },
        disclosureLabel: 'Virtually staged',
        stored: { width: 1024, height: 682 },
        integrity: {
          outcome: 'passed',
          aspectRatioChange: 0,
          classes: [],
          attempts: [
            {
              attempt: 1,
              status: 'checked',
              stagedArtifactId: uuid(600),
              passed: true,
              failedClasses: [],
              privacyPassed: true,
              target: null,
              reason: null,
            },
          ],
        },
        decision: null,
      },
    ],
    integrityFallbacks: [],
    warnings: [],
  };
}

describe('planClaimAuditDecisions', () => {
  const photos = new Map([[uuid(500), 'living-empty.jpg']]);

  it('decides only flagged claims, by variant and position, and every offered image', () => {
    const plan = planClaimAuditDecisions(
      gate2(),
      file({
        claimAudit: {
          claims: {
            default: 'remove',
            decisions: [
              { variant: 'social', position: 0, choice: 'edit', text: '  A  calm   home. ' },
              { variant: 'portal', position: 0, choice: 'accept' },
            ],
          },
          images: {
            default: 'accept',
            decisions: [{ photo: 'living-empty.jpg', choice: 'reject' }],
          },
        },
      }).claimAudit,
      photos,
    );
    expect(plan.claims.map((c) => [c.variant, c.position, c.request, c.origin, c.flags])).toEqual([
      [
        'portal',
        1,
        { choice: 'remove' },
        'default_policy',
        ['validator/claim_support/number_not_in_facts'],
      ],
      [
        'social',
        0,
        { choice: 'edit', text: 'A calm home.' },
        'decisions_file',
        ['validator/claim_support/number_not_in_facts'],
      ],
    ]);
    expect(plan.images.map((i) => [i.photo, i.request.choice, i.origin])).toEqual([
      ['living-empty.jpg', 'reject', 'decisions_file'],
    ]);
    expect(plan.unused).toEqual(['claim portal:0: not a flagged segment of the final draft']);
  });

  it('applies the image default and stops on fail defaults', () => {
    const accepted = planClaimAuditDecisions(gate2(), file().claimAudit, photos);
    expect(accepted.images[0]?.request).toEqual({ choice: 'accept' });
    const failClaims = file({
      claimAudit: { claims: { default: 'fail' }, images: { default: 'accept' } },
    }).claimAudit;
    expect(() => planClaimAuditDecisions(gate2(), failClaims, photos)).toThrow(
      /Claim portal:1 is flagged/,
    );
    const failImages = file({
      claimAudit: { claims: { default: 'remove' }, images: { default: 'fail' } },
    }).claimAudit;
    expect(() => planClaimAuditDecisions(gate2(), failImages, photos)).toThrow(
      /living-empty.jpg \(furnish_living_room\) is not in the decisions file/,
    );
  });

  it('refuses an offered image of a material that is not a project photo', () => {
    expect(() => planClaimAuditDecisions(gate2(), file().claimAudit, new Map())).toThrow(
      /not a project photo/,
    );
  });
});
