import {
  marketFormResponseSchema,
  marketListResponseSchema,
  projectDetailResponseSchema,
  type MarketFormResponse,
  type MarketListResponse,
  type ProjectDetailResponse,
} from '@evidomo/shared';

export const PROJECT_ID = '0b9d3f6e-1c3a-4b2e-8f5d-7a6c5b4d3e2f';
export const RUN_ID = '9d8c7b6a-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const NOW = '2026-10-29T10:00:00.000Z';

// Parsing the fixtures with the shared schemas keeps them honest: a contract change breaks the
// tests here instead of silently drifting.
export const marketList: MarketListResponse = marketListResponseSchema.parse({
  markets: [
    {
      id: 'germany',
      version: 1,
      name: 'Germany',
      outputLanguages: ['de', 'en'],
      defaultOutputLanguage: 'de',
    },
    {
      id: 'uk',
      version: 1,
      name: 'United Kingdom',
      outputLanguages: ['en'],
      defaultOutputLanguage: 'en',
    },
  ],
});

export const marketForm: MarketFormResponse = marketFormResponseSchema.parse({
  market: {
    id: 'germany',
    version: 1,
    name: 'Germany',
    outputLanguages: ['de', 'en'],
    defaultOutputLanguage: 'de',
    currency: 'EUR',
    units: { area: 'm2', volume: 'm3' },
    areaBases: [{ id: 'wohnflaeche', label: 'Living area (Wohnfläche)' }],
    facts: [
      {
        key: 'living_area',
        label: 'Living area',
        required: true,
        type: 'area',
        unit: 'm2',
        basis: { id: 'wohnflaeche', label: 'Living area (Wohnfläche)' },
      },
      {
        key: 'rooms',
        label: 'Rooms',
        required: true,
        type: 'integer',
        min: 1,
        max: 20,
      },
      {
        key: 'heating_type',
        label: 'Heating type',
        required: false,
        type: 'enum',
        values: ['central_heating', 'district_heating'],
      },
      { key: 'price', label: 'Asking price', required: false, type: 'money', currency: 'EUR' },
      { key: 'volume', label: 'Building volume', required: false, type: 'volume', unit: 'm3' },
      { key: 'has_balcony', label: 'Balcony', required: false, type: 'boolean' },
    ],
  },
});

type ProjectOverrides = Partial<{
  inputsLocked: boolean;
  canStartRun: boolean;
  activeRunId: string | null;
  missing: ProjectDetailResponse['readiness']['missing'];
  values: Record<string, string | number | boolean>;
  latestRun: ProjectDetailResponse['latestRun'];
  title: string;
}>;

export function projectDetail(overrides: ProjectOverrides = {}): ProjectDetailResponse {
  const latestRun = overrides.latestRun ?? null;
  return projectDetailResponseSchema.parse({
    project: {
      id: PROJECT_ID,
      title: overrides.title ?? 'Alder Falls Cottage 4',
      status: 'draft',
      officeProfile: { agencyName: 'Fictional Realty Co', tone: 'warm' },
      market: { id: 'germany', version: 1, name: 'Germany' },
      outputLanguage: 'de',
      service: { id: 'listing-launch', version: 1 },
      createdAt: NOW,
      updatedAt: NOW,
    },
    factForm: { values: overrides.values ?? {} },
    materials: [],
    readiness: {
      canStartRun: overrides.canStartRun ?? false,
      inputsLocked: overrides.inputsLocked ?? false,
      activeRunId: overrides.activeRunId ?? null,
      missing: overrides.missing ?? [
        { kind: 'photos', count: 1, min: 3, max: 30 },
        { kind: 'voice_memo' },
        { kind: 'fact', key: 'living_area', problem: 'missing' },
      ],
      photos: { count: 1, min: 3, max: 30, required: true },
      voiceMemo: { present: false, required: true, maxSeconds: 600 },
    },
    latestRun,
  });
}

export function run(status: 'running' | 'completed' | 'failed' = 'completed') {
  return { id: RUN_ID, status, gate: null, createdAt: NOW };
}
