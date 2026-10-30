import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  localizedLabel,
  marketFormResponseSchema,
  projectReadinessSchema,
  serviceResponseSchema,
  type JsonObject,
  type MarketProfile,
  type ServiceDefinition,
} from '@evidomo/shared';
import type { Material } from '../db/repositories/materials.ts';
import type { Run } from '../db/repositories/runs.ts';
import { loadDefinitions } from '../definitions/loader.ts';
import { WALKTHROUGH_FACT_FORM } from '../pipeline/intake/testing.ts';
import { captureInputs, type CaptureInputs } from '../upload/process-upload.ts';
import {
  computeReadiness,
  factFormValues,
  marketForm,
  materialViews,
  serviceView,
} from './views.ts';

let nl: MarketProfile;
let international: MarketProfile;
let service: ServiceDefinition;
let capture: CaptureInputs;

beforeAll(async () => {
  const definitions = await loadDefinitions();
  nl = definitions.getMarket('nl', 1);
  international = definitions.getMarket('international', 1);
  service = definitions.getService('listing-launch', 1);
  capture = captureInputs(service);
});

const projectId = randomUUID();
let clock = Date.UTC(2026, 9, 29, 10);

function material(
  kind: Material['kind'],
  overrides: Partial<Material> = {},
  metadata: JsonObject | null = kind === 'photo'
    ? { width: 2048, height: 1536, sourceFormat: 'jpeg', sourceWidth: 4032, sourceHeight: 3024 }
    : {
        durationMs: 61_000,
        sampleRate: 16_000,
        sourceContainer: 'matroska,webm',
        sourceCodec: 'opus',
      },
): Material {
  clock += 1000;
  return {
    id: randomUUID(),
    projectId,
    kind,
    status: 'ready',
    storageKey: `projects/${projectId}/materials/${randomUUID()}.jpg`,
    mimeType: kind === 'photo' ? 'image/jpeg' : 'audio/wav',
    sizeBytes: 1000,
    sha256: 'a'.repeat(64),
    metadata,
    createdAt: new Date(clock),
    updatedAt: new Date(clock),
    ...overrides,
  };
}

function run(status: Run['status']): Run {
  return {
    id: randomUUID(),
    projectId,
    serviceId: 'listing-launch',
    serviceVersion: 1,
    marketProfileId: 'nl',
    marketProfileVersion: 1,
    outputLanguage: 'en',
    status,
    gate: status === 'awaiting_gate' ? 'fact_conflicts' : null,
    currentStepId: null,
    failureReason: status === 'failed' ? 'x' : null,
    lastEventSeq: 0,
    createdAt: new Date(clock),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(clock),
  };
}

const photos = (n: number): Material[] => Array.from({ length: n }, () => material('photo'));

describe('marketForm', () => {
  it('describes every nl fact for the form and sends no internal field', () => {
    const view = marketForm(nl);
    expect(marketFormResponseSchema.parse({ market: view }).market).toEqual(view);
    expect(view).toMatchObject({
      id: 'nl',
      version: 1,
      outputLanguages: ['en', 'nl'],
      defaultOutputLanguage: 'en',
      currency: 'EUR',
      units: { area: 'm2', volume: 'm3' },
    });
    expect(view.facts.map((fact) => fact.key)).toEqual(nl.facts.map((fact) => fact.key));
    expect(view.facts.find((fact) => fact.key === 'living_area')).toEqual({
      key: 'living_area',
      label: 'Living area (woonoppervlakte)',
      labels: nl.facts.find((fact) => fact.key === 'living_area')?.labels,
      required: true,
      type: 'area',
      unit: 'm2',
      basis: {
        id: 'NEN2580',
        label: nl.area_bases[0]?.label,
        labels: nl.area_bases[0]?.labels,
      },
    });
    expect(view.facts.find((fact) => fact.key === 'build_year')).toMatchObject({
      type: 'integer',
      min: 1000,
      max: 2100,
      required: false,
    });
    const serialized = JSON.stringify(view);
    for (const internal of [
      'transcription_keywords',
      'evidence_objects',
      'publication_checklist',
    ]) {
      expect(serialized).not.toContain(internal);
    }
    expect(serialized).not.toContain('meterkast');
  });
});

describe('marketForm translated labels', () => {
  it('sends the English source and every translation of the market, fields, bases, and options', () => {
    const view = marketForm(international);
    expect(marketFormResponseSchema.parse({ market: view }).market).toEqual(view);
    expect(view.name).toBe('International');
    expect(view.names).toEqual({
      tr: 'Uluslararası',
      nl: 'Internationaal',
      it: 'Internazionale',
      es: 'Internacional',
    });
    expect(view.areaBases[0]?.labels.nl).toMatch(/^Netto binnenoppervlakte/);
    expect(view.facts.find((fact) => fact.key === 'living_area')).toMatchObject({
      label: 'Living area',
      labels: {
        tr: 'Yaşam alanı',
        nl: 'Woonoppervlakte',
        it: 'Superficie abitabile',
        es: 'Superficie habitable',
      },
    });
    const type = view.facts.find((fact) => fact.key === 'property_type');
    expect(type).toMatchObject({
      type: 'enum',
      values: ['apartment', 'house'],
      options: [
        {
          value: 'apartment',
          label: 'Apartment',
          labels: { tr: 'Daire', nl: 'Appartement', it: 'Appartamento', es: 'Apartamento' },
        },
        {
          value: 'house',
          label: 'House',
          labels: { tr: 'Ev', nl: 'Huis', it: 'Casa', es: 'Casa' },
        },
      ],
    });
  });

  it('shows an option without a label as its value, with no translations (energy classes)', () => {
    const energy = marketForm(nl).facts.find((fact) => fact.key === 'energy_label');
    expect(energy?.type === 'enum' ? energy.options.slice(0, 2) : []).toEqual([
      { value: 'A++++', label: 'A++++', labels: {} },
      { value: 'A+++', label: 'A+++', labels: {} },
    ]);
  });

  it('sends empty maps for a profile without translations, so the web falls back to English', () => {
    const plain: MarketProfile = {
      ...international,
      names: undefined,
      area_bases: international.area_bases.map(({ labels: _labels, ...basis }) => basis),
      facts: international.facts.map((fact) => {
        const { labels: _labels, ...rest } = fact;
        return rest;
      }),
    };
    const view = marketForm(plain);
    expect(view.names).toEqual({});
    expect(view.areaBases.every((basis) => Object.keys(basis.labels).length === 0)).toBe(true);
    expect(view.facts.every((fact) => Object.keys(fact.labels).length === 0)).toBe(true);
    for (const fact of view.facts) {
      expect(localizedLabel(fact, 'tr')).toBe(fact.label);
    }
  });
});

describe('serviceView', () => {
  it('lists the capture inputs of listing-launch v1 without steps or models', () => {
    const view = serviceView(service);
    expect(serviceResponseSchema.parse({ service: view }).service).toEqual(view);
    expect(view.inputs).toEqual([
      { key: 'photos', type: 'images', min: 10, max: 30, required: true },
      { key: 'voice_memo', type: 'audio', maxSeconds: 600, required: true },
      { key: 'facts', type: 'form', required: true },
    ]);
    expect(JSON.stringify(view)).not.toContain('muse-');
  });
});

describe('materialViews', () => {
  it('orders photos by upload order with 1-based positions, then the voice memo', () => {
    const memo = material('voice_memo');
    const [first, second] = photos(2);
    if (first === undefined || second === undefined) throw new Error('unreachable');
    const views = materialViews([memo, first, second]);
    expect(views.map((view) => [view.id, view.position])).toEqual([
      [first.id, 1],
      [second.id, 2],
      [memo.id, 1],
    ]);
    expect(views[0]).toMatchObject({ width: 2048, height: 1536, durationMs: null });
    expect(views[2]).toMatchObject({ width: null, height: null, durationMs: 61_000 });
  });

  it('exposes the failure reason of failed rows only', () => {
    const [view] = materialViews([
      material('photo', { status: 'failed' }, { failureReason: 'internal_error' }),
    ]);
    expect(view).toMatchObject({ status: 'failed', failureReason: 'internal_error', width: null });
  });
});

describe('computeReadiness', () => {
  const ready = (materials: Material[], runs: Run[] = [], factForm = WALKTHROUGH_FACT_FORM) =>
    projectReadinessSchema.parse(
      computeReadiness({ capture, market: nl, factForm, materials, runs }),
    );

  it('lists every missing input of a new project', () => {
    expect(ready([], [], {})).toEqual({
      canStartRun: false,
      inputsLocked: false,
      activeRunId: null,
      missing: [
        { kind: 'photos', count: 0, min: 10, max: 30 },
        { kind: 'voice_memo' },
        { kind: 'fact', key: 'energy_label', problem: 'missing' },
        { kind: 'fact', key: 'living_area', problem: 'missing' },
      ],
      photos: { count: 0, min: 10, max: 30, required: true },
      voiceMemo: { present: false, required: true, maxSeconds: 600 },
    });
  });

  it('is ready with 10 photos, a memo, and the required facts', () => {
    const result = ready([...photos(10), material('voice_memo')]);
    expect(result.missing).toEqual([]);
    expect(result.canStartRun).toBe(true);
  });

  it('counts only ready materials and reports invalid stored values', () => {
    const result = ready(
      [...photos(9), material('photo', { status: 'failed' }, { failureReason: 'undecodable' })],
      [],
      { ...WALKTHROUGH_FACT_FORM, energy_label: 'Z' },
    );
    expect(result.missing).toEqual([
      { kind: 'photos', count: 9, min: 10, max: 30 },
      { kind: 'voice_memo' },
      { kind: 'fact', key: 'energy_label', problem: 'invalid' },
    ]);
  });

  it('locks inputs while a run is active or completed and blocks a start while one is active', () => {
    const inputs = [...photos(10), material('voice_memo')];
    for (const status of ['queued', 'running', 'awaiting_gate'] as const) {
      const active = run(status);
      expect(ready(inputs, [run('failed'), active])).toMatchObject({
        canStartRun: false,
        inputsLocked: true,
        activeRunId: active.id,
        missing: [],
      });
    }
    expect(ready(inputs, [run('completed')])).toMatchObject({
      canStartRun: true,
      inputsLocked: true,
      activeRunId: null,
    });
  });

  it('unlocks inputs when every run has failed', () => {
    const inputs = [...photos(10), material('voice_memo')];
    expect(ready(inputs, [run('failed'), run('failed')])).toMatchObject({
      canStartRun: true,
      inputsLocked: false,
      activeRunId: null,
    });
  });
});

describe('factFormValues', () => {
  it('returns scalar values and leaves anything else out', () => {
    expect(factFormValues({ a: 1, b: 'x', c: false, d: { nested: true }, e: null })).toEqual({
      a: 1,
      b: 'x',
      c: false,
    });
  });
});
