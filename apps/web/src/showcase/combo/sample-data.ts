// Data-only samples for the combination's gate pages: the real gate views read these through a
// stubbed `fetch` (sample-api.tsx). Built from the test fixtures so the shapes stay the ones the
// shared schemas accept; every value is synthetic.
import {
  claimAuditGateResponseSchema,
  factConflictsGateResponseSchema,
  type ClaimAuditGateResponse,
  type FactConflictsGateResponse,
} from '@evidomo/shared';
import { auditGate, CLAIM } from '../../__tests__/claim-audit-fixtures';
import { FACT, MATERIAL_ID, RUN_ID, TRANSCRIPT_ID, openGate } from '../../__tests__/gate-fixtures';

export { RUN_ID, MATERIAL_ID };

/** The sample clip is a short synthetic tone, so every turn starts at the beginning of it. */
export const SAMPLE_CLIP_MS = { startMs: 0, endMs: 2_600 } as const;

const TURN_QUOTE = 'Four rooms, and a small study at the back.';

/** Gate 1 with one conflict: the form and the walkthrough say 4 rooms, a photo region shows 5. */
export function sampleConflictsGate(
  decisions: Record<string, unknown> = {},
): FactConflictsGateResponse {
  const base = openGate();
  const rooms = base.conflicts.find((conflict) => conflict.id === 'K02');
  const formSide = rooms?.sides[0];
  const photoSide = rooms?.sides[1];
  if (rooms === undefined || formSide === undefined || photoSide === undefined) {
    throw new Error('The gate fixture no longer has the rooms conflict (K02).');
  }
  const turnFact = {
    id: FACT.areaTurn,
    key: 'rooms',
    value: 4,
    unit: null,
    basis: null,
    status: 'conflicted',
    assertion: 'stated',
    source: {
      kind: 'transcript_turn',
      transcriptArtifactId: TRANSCRIPT_ID,
      turnIndex: 2,
      ...SAMPLE_CLIP_MS,
      quote: TURN_QUOTE,
    },
  };
  const conflict = {
    ...rooms,
    explanation: 'The form and the walkthrough say 4 rooms; one photo shows 5.',
    decision: decisions[rooms.id] ?? null,
    sides: [
      {
        ...formSide,
        factIds: [...formSide.factIds, FACT.areaTurn],
        evidenceIds: [...formSide.evidenceIds, 'C02'],
        sourceKinds: ['form', 'transcript_turn'],
        facts: [...formSide.facts, turnFact],
      },
      {
        ...photoSide,
        facts: photoSide.facts.map((fact) => ({ ...fact, source: { ...fact.source } })),
      },
    ],
  };
  return factConflictsGateResponseSchema.parse({
    ...base,
    state: 'open',
    runStatus: 'awaiting_gate',
    conflictCount: 1,
    openCount: conflict.decision === null ? 1 : 0,
    conflicts: [conflict],
  });
}

/** Gate 2 with one portal text of two sentences, one of them flagged. */
export function sampleAuditGate(decisions: Record<string, unknown> = {}): ClaimAuditGateResponse {
  const full = auditGate({ decisions, withoutQa: true, withoutImages: true });
  const portal = full.variants.find((variant) => variant.kind === 'portal');
  if (portal === undefined) throw new Error('The audit fixture no longer has a portal variant.');
  const segments = portal.segments.filter(
    (segment) => segment.claimId === CLAIM.area || segment.claimId === CLAIM.rooms,
  );
  const open = segments.some(
    (segment) => segment.claimId === CLAIM.rooms && segment.decision === null,
  );
  return claimAuditGateResponseSchema.parse({
    ...full,
    variants: [{ ...portal, segments }],
    counts: { flaggedClaims: 1, openClaims: open ? 1 : 0, offeredImages: 0, openImages: 0 },
    openCount: open ? 1 : 0,
    facts: full.facts.map((fact) =>
      fact.source.kind === 'transcript_turn'
        ? { ...fact, source: { ...fact.source, ...SAMPLE_CLIP_MS } }
        : fact,
    ),
  });
}
