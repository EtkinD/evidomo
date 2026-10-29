import {
  factConflictsGateResponseSchema,
  runSnapshotSchema,
  type FactConflictsGateResponse,
  type RunSnapshot,
} from '@evidomo/shared';

export const RUN_ID = '0b9f7c1e-5d2a-4e8b-9c3d-1a2b3c4d5e6f';
export const PROJECT_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
export const TRANSCRIPT_ID = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
export const MATERIAL_ID = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
export const MASK_ID = '7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d';
const CONFLICTS_ARTIFACT_ID = '8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e';
const AT = '2026-10-29T10:00:00.000Z';

/** Fact IDs, named by what they hold. */
export const FACT = {
  areaForm: '10000000-0000-4000-8000-000000000001',
  areaTurn: '10000000-0000-4000-8000-000000000002',
  areaOther: '10000000-0000-4000-8000-000000000003',
  roomsForm: '10000000-0000-4000-8000-000000000004',
  roomsPhoto: '10000000-0000-4000-8000-000000000005',
  stationA: '10000000-0000-4000-8000-000000000006',
  stationB: '10000000-0000-4000-8000-000000000007',
} as const;

export function runSnapshot(): RunSnapshot {
  return runSnapshotSchema.parse({
    id: RUN_ID,
    projectId: PROJECT_ID,
    status: 'awaiting_gate',
    serviceId: 'listing-pack',
    serviceVersion: 1,
    marketProfileId: 'germany',
    marketProfileVersion: 1,
    outputLanguage: 'de',
    gate: 'fact_conflicts',
    currentStepId: 'reconcile',
    failureReason: null,
    createdAt: AT,
    startedAt: AT,
    finishedAt: null,
    updatedAt: AT,
    costUsd: '0.5',
    lastEventSeq: 4,
    costCapUsd: '2',
    maxExecutionsPerAttempt: 2,
    steps: [],
    export: null,
  });
}

const fact = (
  id: string,
  key: string,
  value: unknown,
  source: unknown,
  extra: { unit?: string | null; basis?: string | null } = {},
) => ({
  id,
  key,
  value,
  unit: extra.unit ?? null,
  basis: extra.basis ?? null,
  status: 'conflicted',
  assertion: 'stated',
  source,
});

const AREA = { unit: 'm2', basis: 'wohnflaeche' };

const conflictBase = {
  detectedBy: ['code'],
  decision: null,
};

export function openGate(): FactConflictsGateResponse {
  return factConflictsGateResponseSchema.parse({
    runId: RUN_ID,
    runStatus: 'awaiting_gate',
    state: 'open',
    factSheetArtifactId: '9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f',
    conflictsArtifactId: CONFLICTS_ARTIFACT_ID,
    conflictCount: 3,
    openCount: 3,
    conflicts: [
      {
        ...conflictBase,
        id: 'K01',
        key: 'living_area',
        kind: 'value_mismatch',
        explanation: 'The form and the walkthrough disagree about the living area.',
        sides: [
          {
            key: 'living_area',
            value: 92,
            ...AREA,
            factIds: [FACT.areaForm, FACT.areaTurn],
            evidenceIds: ['F.living_area', 'C01'],
            sourceKinds: ['form', 'transcript_turn'],
            facts: [
              fact(FACT.areaForm, 'living_area', 92, { kind: 'form', field: 'living_area' }, AREA),
              fact(
                FACT.areaTurn,
                'living_area',
                92,
                {
                  kind: 'transcript_turn',
                  transcriptArtifactId: TRANSCRIPT_ID,
                  turnIndex: 3,
                  startMs: 83_400,
                  endMs: 91_600,
                  quote: 'about ninety-two square metres',
                },
                AREA,
              ),
            ],
          },
          {
            key: 'living_area',
            value: 98,
            ...AREA,
            factIds: [FACT.areaOther],
            evidenceIds: ['C02'],
            sourceKinds: ['transcript_turn'],
            facts: [
              fact(
                FACT.areaOther,
                'living_area',
                98,
                {
                  kind: 'transcript_turn',
                  transcriptArtifactId: TRANSCRIPT_ID,
                  turnIndex: 7,
                  startMs: 142_000,
                  endMs: 150_250,
                  quote: 'ninety-eight with the extension',
                },
                AREA,
              ),
            ],
          },
        ],
      },
      {
        ...conflictBase,
        id: 'K02',
        key: 'rooms',
        kind: 'count_mismatch',
        explanation: 'The form says 4 rooms; the photos show 5.',
        sides: [
          {
            key: 'rooms',
            value: 4,
            unit: null,
            basis: null,
            factIds: [FACT.roomsForm],
            evidenceIds: ['F.rooms'],
            sourceKinds: ['form'],
            facts: [fact(FACT.roomsForm, 'rooms', 4, { kind: 'form', field: 'rooms' })],
          },
          {
            key: 'rooms',
            value: 5,
            unit: null,
            basis: null,
            factIds: [FACT.roomsPhoto],
            evidenceIds: ['P01.R1'],
            sourceKinds: ['photo_region'],
            facts: [
              fact(FACT.roomsPhoto, 'rooms', 5, {
                kind: 'photo_region',
                materialId: MATERIAL_ID,
                region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
                maskArtifactId: MASK_ID,
              }),
            ],
          },
        ],
      },
      {
        ...conflictBase,
        id: 'K03',
        key: 'other:station_minutes',
        kind: 'value_mismatch',
        explanation: 'Two different walking times to the station.',
        sides: [
          {
            key: 'other:station_minutes',
            value: 12,
            unit: 'minute',
            basis: null,
            factIds: [FACT.stationA],
            evidenceIds: ['C03'],
            sourceKinds: ['form'],
            facts: [
              fact(
                FACT.stationA,
                'other:station_minutes',
                12,
                { kind: 'form', field: 'other:station_minutes' },
                { unit: 'minute' },
              ),
            ],
          },
          {
            key: 'other:station_minutes',
            value: 20,
            unit: 'minute',
            basis: null,
            factIds: [FACT.stationB],
            evidenceIds: ['C04'],
            sourceKinds: ['form'],
            facts: [
              fact(
                FACT.stationB,
                'other:station_minutes',
                20,
                { kind: 'form', field: 'other:station_walk' },
                { unit: 'minute' },
              ),
            ],
          },
        ],
      },
    ],
  });
}

/** The gate as the server returns it after `decisions` (conflict ID → decision) were stored. */
export function gateWith(
  decisions: Record<string, unknown>,
  state: FactConflictsGateResponse['state'] = 'open',
): FactConflictsGateResponse {
  const base = openGate();
  const conflicts = base.conflicts.map((conflict) => ({
    ...conflict,
    decision: decisions[conflict.id] ?? null,
  }));
  const open = state === 'open' ? conflicts.filter((c) => c.decision === null).length : 0;
  return factConflictsGateResponseSchema.parse({
    ...base,
    state,
    runStatus: state === 'open' ? 'awaiting_gate' : state === 'suspended' ? 'failed' : 'running',
    conflicts,
    openCount: open,
  });
}

export const DECIDED_AT = '2026-10-29T10:05:00.000Z';

type Decisions = Record<string, unknown>;

/** The last conflict's sides disagree on the unit (minutes against hours). */
export function mixedUnitGate(decisions: Decisions): FactConflictsGateResponse {
  const base = gateWith(decisions);
  return factConflictsGateResponseSchema.parse({
    ...base,
    conflicts: base.conflicts.map((conflict) =>
      conflict.id === 'K03'
        ? {
            ...conflict,
            sides: conflict.sides.map((side, index) => ({
              ...side,
              unit: index === 0 ? 'minute' : 'hour',
              facts: side.facts.map((f) => ({ ...f, unit: index === 0 ? 'minute' : 'hour' })),
            })),
          }
        : conflict,
    ),
  });
}

/** The last conflict's sides hold a number and a text. */
export function mixedTypeGate(): FactConflictsGateResponse {
  const base = openGate();
  return factConflictsGateResponseSchema.parse({
    ...base,
    conflicts: base.conflicts.map((conflict) =>
      conflict.id === 'K03'
        ? {
            ...conflict,
            sides: conflict.sides.map((side, index) => ({
              ...side,
              value: index === 0 ? 12 : 'about twenty',
              facts: side.facts.map((f) => ({ ...f, value: index === 0 ? 12 : 'about twenty' })),
            })),
          }
        : conflict,
    ),
  });
}
