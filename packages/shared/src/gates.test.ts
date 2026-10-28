import { describe, expect, it } from 'vitest';
import { factSourceSchema } from './domain.ts';
import {
  factConflictDecisionRequestSchema,
  factConflictDecisionSchema,
  gateConflictParamsSchema,
} from './gates.ts';
import { gateDecidedPayloadSchema } from './run-events.ts';

const uuid = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';

describe('factConflictDecisionRequestSchema', () => {
  it('accepts the three choices and trims edited text', () => {
    expect(factConflictDecisionRequestSchema.parse({ choice: 'accept', factId: uuid })).toEqual({
      choice: 'accept',
      factId: uuid,
    });
    expect(factConflictDecisionRequestSchema.parse({ choice: 'reject' })).toEqual({
      choice: 'reject',
    });
    expect(
      factConflictDecisionRequestSchema.parse({ choice: 'edit', value: '  laminate  ' }),
    ).toEqual({ choice: 'edit', value: 'laminate' });
    expect(
      factConflictDecisionRequestSchema.parse({ choice: 'edit', value: 92.5, unit: null }),
    ).toEqual({ choice: 'edit', value: 92.5, unit: null });
  });

  it('refuses other choices, extra fields, and values that are not exact scalars', () => {
    const refused = [
      { choice: 'remove' },
      { choice: 'accept' },
      { choice: 'accept', factId: 'F.living_area' },
      { choice: 'reject', factId: uuid },
      { choice: 'edit' },
      { choice: 'edit', value: null },
      { choice: 'edit', value: '   ' },
      { choice: 'edit', value: 'x'.repeat(301) },
      { choice: 'edit', value: { amount: 92 } },
      { choice: 'edit', value: Number.POSITIVE_INFINITY },
    ];
    for (const body of refused) {
      expect(factConflictDecisionRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('Gate 1 contracts', () => {
  it('validates path parameters', () => {
    expect(gateConflictParamsSchema.safeParse({ runId: uuid, conflictId: 'K01' }).success).toBe(
      true,
    );
    expect(gateConflictParamsSchema.safeParse({ runId: uuid, conflictId: 'K1' }).success).toBe(
      false,
    );
    expect(gateConflictParamsSchema.safeParse({ runId: 'x', conflictId: 'K01' }).success).toBe(
      false,
    );
  });

  it('describes a decided conflict by its choice', () => {
    const decidedAt = '2026-10-28T12:00:00.000Z';
    expect(
      factConflictDecisionSchema.parse({
        choice: 'edit',
        key: 'living_area',
        value: 92.5,
        unit: 'm2',
        basis: 'NEN2580',
        decidedAt,
      }).choice,
    ).toBe('edit');
    expect(
      factConflictDecisionSchema.safeParse({ choice: 'accept', factIds: [], decidedAt }).success,
    ).toBe(false);
  });

  it('accepts a gate_decision fact source that cites the conflict', () => {
    const source = {
      kind: 'gate_decision',
      gate: 'fact_conflicts',
      conflictsArtifactId: uuid,
      conflictId: 'K02',
    };
    expect(factSourceSchema.parse(source)).toEqual(source);
    expect(factSourceSchema.safeParse({ ...source, gate: 'claim_audit' }).success).toBe(false);
    expect(factSourceSchema.safeParse({ ...source, conflictId: 'V01' }).success).toBe(false);
  });

  it('keeps the gate_decided event to counts', () => {
    const payload = {
      gate: 'fact_conflicts',
      stepId: 'reconciliation',
      acceptedCount: 1,
      editedCount: 1,
      rejectedCount: 0,
      verifiedFactCount: 2,
      rejectedFactCount: 3,
      createdFactCount: 1,
    };
    expect(gateDecidedPayloadSchema.parse(payload)).toEqual(payload);
    expect(gateDecidedPayloadSchema.safeParse({ ...payload, value: 92.5 }).success).toBe(false);
  });
});
