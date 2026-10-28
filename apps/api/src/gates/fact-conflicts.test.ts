import { randomUUID } from 'node:crypto';
import type { FactConflict, JsonValue } from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import type { Decision } from '../db/repositories/decisions.ts';
import { conflictDecision } from './fact-conflicts.ts';

const [a1, a2, b1] = [randomUUID(), randomUUID(), randomUUID()];
const conflict: FactConflict = {
  id: 'K01',
  key: 'energy_label',
  kind: 'value_mismatch',
  detectedBy: ['code'],
  explanation: 'The form and the walkthrough name different labels.',
  factIds: [a1, a2, b1],
  sides: [
    {
      key: 'energy_label',
      value: 'B',
      unit: null,
      basis: null,
      factIds: [a1, a2],
      evidenceIds: ['C01', 'C02'],
      sourceKinds: ['transcript_turn'],
    },
    {
      key: 'energy_label',
      value: 'C',
      unit: null,
      basis: null,
      factIds: [b1],
      evidenceIds: ['F.energy_label'],
      sourceKinds: ['form'],
    },
  ],
};

function rows(
  choices: Record<string, Decision['choice']>,
  editedValue: JsonValue | null = null,
): Map<string, Decision> {
  return new Map(
    Object.entries(choices).map(([targetId, choice], index) => [
      targetId,
      {
        id: randomUUID(),
        runId: randomUUID(),
        gate: 'fact_conflicts',
        targetKind: 'fact',
        targetId,
        choice,
        editedValue: choice === 'edit' ? editedValue : null,
        decidedBy: randomUUID(),
        decidedAt: new Date(Date.UTC(2026, 9, 28, 12, 0, index)),
      },
    ]),
  );
}

const edit = { key: 'energy_label', value: 'A', unit: null, basis: null };

describe('conflictDecision', () => {
  it('derives accept, edit, and reject from the per-fact rows, with the latest time', () => {
    expect(
      conflictDecision(conflict, rows({ [a1]: 'accept', [a2]: 'accept', [b1]: 'reject' })),
    ).toEqual({ choice: 'accept', factIds: [a1, a2], decidedAt: '2026-10-28T12:00:02.000Z' });
    expect(
      conflictDecision(conflict, rows({ [a1]: 'edit', [a2]: 'edit', [b1]: 'edit' }, edit)),
    ).toMatchObject({ choice: 'edit', ...edit });
    expect(
      conflictDecision(conflict, rows({ [a1]: 'reject', [a2]: 'reject', [b1]: 'reject' })),
    ).toMatchObject({ choice: 'reject' });
  });

  it('leaves a conflict open unless every fact has a row of one consistent shape', () => {
    const open = [
      rows({}),
      rows({ [a1]: 'accept', [a2]: 'accept' }),
      // part of a side accepted
      rows({ [a1]: 'accept', [a2]: 'reject', [b1]: 'reject' }),
      // two sides accepted
      rows({ [a1]: 'accept', [a2]: 'accept', [b1]: 'accept' }),
      rows({ [a1]: 'accept', [a2]: 'accept', [b1]: 'remove' }),
      rows({ [a1]: 'edit', [a2]: 'edit', [b1]: 'reject' }, edit),
      rows({ [a1]: 'edit', [a2]: 'edit', [b1]: 'edit' }, 'A'),
    ];
    for (const decisions of open) expect(conflictDecision(conflict, decisions)).toBeNull();

    const mixed = rows({ [a1]: 'edit', [a2]: 'edit', [b1]: 'edit' }, edit);
    const other = mixed.get(b1);
    if (other === undefined) throw new Error('fixture row missing');
    mixed.set(b1, { ...other, editedValue: { ...edit, value: 'B' } });
    expect(conflictDecision(conflict, mixed)).toBeNull();
  });
});
