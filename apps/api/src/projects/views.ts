import {
  failedMaterialMetadataSchema,
  photoMaterialMetadataSchema,
  voiceMemoMaterialMetadataSchema,
  type FactFormField,
  type FactFormValues,
  type JsonObject,
  type MarketForm,
  type MarketProfile,
  type MarketSummary,
  type ProjectDetailResponse,
  type ProjectMaterial,
  type ProjectReadiness,
  type ProjectRunSummary,
  type Project as ProjectView,
  type ReadinessItem,
  type RunStatus,
  type ServiceDefinition,
  type ServiceResponse,
  factFormValueSchema,
} from '@evidomo/shared';
import type { Material } from '../db/repositories/materials.ts';
import type { Project } from '../db/repositories/projects.ts';
import type { Run } from '../db/repositories/runs.ts';
import { FactFormError, factFormToCandidates } from '../pipeline/extraction/form.ts';
import type { CaptureInputs } from '../upload/process-upload.ts';
import { inputsLocked } from './input-lock.ts';

// Database rows and definitions → the shared response shapes (packages/shared/src/projects.ts).
// Only fields listed there leave the server.

export function marketSummary(market: MarketProfile): MarketSummary {
  return {
    id: market.id,
    version: market.version,
    name: market.name,
    outputLanguages: [...market.output_languages],
    defaultOutputLanguage: market.default_output_language,
  };
}

function factField(market: MarketProfile, fact: MarketProfile['facts'][number]): FactFormField {
  const common = { key: fact.key, label: fact.label, required: fact.required };
  switch (fact.type) {
    case 'enum':
      return { ...common, type: 'enum', values: [...fact.values] };
    case 'area': {
      const basis = market.area_bases.find((candidate) => candidate.id === fact.basis);
      // The schema refuses an area fact whose basis is not listed, so this is a loader bug.
      if (basis === undefined) throw new Error(`Area basis ${fact.basis} missing in ${market.id}`);
      return { ...common, type: 'area', unit: market.units.area, basis: { ...basis } };
    }
    case 'volume':
      if (market.units.volume === undefined) {
        throw new Error(`Market ${market.id} has a volume fact without units.volume`);
      }
      return { ...common, type: 'volume', unit: market.units.volume };
    case 'integer':
      return { ...common, type: 'integer', min: fact.min ?? null, max: fact.max ?? null };
    case 'money':
      if (market.currency === undefined) {
        throw new Error(`Market ${market.id} has a money fact without a currency`);
      }
      return { ...common, type: 'money', currency: market.currency };
    case 'boolean':
      return { ...common, type: 'boolean' };
  }
}

export function marketForm(market: MarketProfile): MarketForm {
  return {
    ...marketSummary(market),
    currency: market.currency ?? null,
    units: { area: market.units.area, volume: market.units.volume ?? null },
    areaBases: market.area_bases.map((basis) => ({ id: basis.id, label: basis.label })),
    facts: market.facts.map((fact) => factField(market, fact)),
  };
}

export function serviceView(service: ServiceDefinition): ServiceResponse['service'] {
  return {
    id: service.id,
    version: service.version,
    name: service.name,
    inputs: service.inputs.map((input) => {
      switch (input.type) {
        case 'images':
          return {
            key: input.key,
            type: 'images',
            min: input.min,
            max: input.max,
            required: input.required,
          };
        case 'audio':
          return {
            key: input.key,
            type: 'audio',
            maxSeconds: input.max_seconds,
            required: input.required,
          };
        case 'form':
          return { key: input.key, type: 'form', required: input.required };
      }
    }),
  };
}

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'awaiting_gate'];

export function runSummary(run: Run): ProjectRunSummary {
  return {
    id: run.id,
    status: run.status,
    gate: run.gate,
    createdAt: run.createdAt.toISOString(),
  };
}

/** The latest of the project's runs (they come in creation order), or null. */
export function latestRun(runs: readonly Run[]): Run | undefined {
  return runs.at(-1);
}

/** Materials in API order (photos by position, then the voice memo), each with its position. */
export function materialViews(materials: readonly Material[]): ProjectMaterial[] {
  const positions = new Map<string, number>();
  const ordered = [
    ...materials.filter((material) => material.kind === 'photo'),
    ...materials.filter((material) => material.kind === 'voice_memo'),
  ];
  return ordered.map((material) => {
    const position = (positions.get(material.kind) ?? 0) + 1;
    positions.set(material.kind, position);
    return materialView(material, position);
  });
}

export function materialView(material: Material, position: number): ProjectMaterial {
  const photo =
    material.kind === 'photo' && material.status === 'ready'
      ? photoMaterialMetadataSchema.safeParse(material.metadata)
      : undefined;
  const memo =
    material.kind === 'voice_memo' && material.status === 'ready'
      ? voiceMemoMaterialMetadataSchema.safeParse(material.metadata)
      : undefined;
  const failed =
    material.status === 'failed'
      ? failedMaterialMetadataSchema.safeParse(material.metadata)
      : undefined;
  return {
    id: material.id,
    kind: material.kind,
    status: material.status,
    position,
    mimeType: material.mimeType,
    sizeBytes: material.sizeBytes,
    width: photo?.success === true ? photo.data.width : null,
    height: photo?.success === true ? photo.data.height : null,
    durationMs: memo?.success === true ? memo.data.durationMs : null,
    failureReason: failed?.success === true ? failed.data.failureReason : null,
    createdAt: material.createdAt.toISOString(),
  };
}

/** Fact form problems as readiness items: required facts left empty, values that do not fit. */
function factItems(factForm: JsonObject, market: MarketProfile): ReadinessItem[] {
  try {
    factFormToCandidates(factForm, market);
    return [];
  } catch (error) {
    if (!(error instanceof FactFormError)) throw error;
    return [
      ...error.missing.map((key): ReadinessItem => ({ kind: 'fact', key, problem: 'missing' })),
      ...error.invalid.map((key): ReadinessItem => ({ kind: 'fact', key, problem: 'invalid' })),
    ];
  }
}

export interface ReadinessInput {
  readonly capture: CaptureInputs;
  readonly market: MarketProfile;
  readonly factForm: JsonObject;
  readonly materials: readonly Material[];
  readonly runs: readonly Run[];
}

/**
 * What a run needs from the project, by the same rules the run start enforces: the service's
 * photo count, a voice memo when required, and every required fact present and valid by the
 * fact extraction step's own check (`factFormToCandidates`). Only `ready` materials count.
 */
export function computeReadiness(input: ReadinessInput): ProjectReadiness {
  const { capture } = input;
  const ready = input.materials.filter((material) => material.status === 'ready');
  const photoCount = ready.filter((material) => material.kind === 'photo').length;
  const hasVoiceMemo = ready.some((material) => material.kind === 'voice_memo');
  const missing: ReadinessItem[] = [];
  const needsPhotos = capture.photos.required || photoCount > 0;
  if (needsPhotos && (photoCount < capture.photos.min || photoCount > capture.photos.max)) {
    missing.push({
      kind: 'photos',
      count: photoCount,
      min: capture.photos.min,
      max: capture.photos.max,
    });
  }
  if (capture.voiceMemo.required && !hasVoiceMemo) missing.push({ kind: 'voice_memo' });
  missing.push(...factItems(input.factForm, input.market));
  const active = input.runs.find((run) => ACTIVE_RUN_STATUSES.includes(run.status));
  return {
    canStartRun: missing.length === 0 && active === undefined,
    inputsLocked: inputsLocked(input.runs),
    activeRunId: active?.id ?? null,
    missing,
    photos: {
      count: photoCount,
      min: capture.photos.min,
      max: capture.photos.max,
      required: capture.photos.required,
    },
    voiceMemo: {
      present: hasVoiceMemo,
      required: capture.voiceMemo.required,
      maxSeconds: capture.voiceMemo.maxSeconds,
    },
  };
}

/** `market` undefined: the definition is no longer loaded (list entries only), `name` is null. */
export function projectView(
  project: Project,
  market: MarketProfile | undefined,
  service: Pick<ServiceDefinition, 'id' | 'version'>,
): ProjectView {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    officeProfile: project.officeProfile,
    market: {
      id: project.marketProfileId,
      version: project.marketProfileVersion,
      name: market?.name ?? null,
    },
    outputLanguage: project.outputLanguage,
    service: { id: service.id, version: service.version },
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

/**
 * Stored form values. The column is written through `checkFactForm` (or the CLI's validated
 * project file); a value that is not a scalar is left out rather than failing the page.
 */
export function factFormValues(factForm: JsonObject): FactFormValues {
  const values: FactFormValues = {};
  for (const [key, value] of Object.entries(factForm)) {
    const parsed = factFormValueSchema.safeParse(value);
    if (parsed.success) values[key] = parsed.data;
  }
  return values;
}

export interface ProjectDetailInput {
  readonly project: Project;
  readonly market: MarketProfile;
  readonly service: ServiceDefinition;
  readonly capture: CaptureInputs;
  readonly materials: readonly Material[];
  readonly runs: readonly Run[];
}

export function projectDetail(input: ProjectDetailInput): ProjectDetailResponse {
  const latest = latestRun(input.runs);
  return {
    project: projectView(input.project, input.market, input.service),
    factForm: { values: factFormValues(input.project.factForm) },
    materials: materialViews(input.materials),
    readiness: computeReadiness({
      capture: input.capture,
      market: input.market,
      factForm: input.project.factForm,
      materials: input.materials,
      runs: input.runs,
    }),
    latestRun: latest === undefined ? null : runSummary(latest),
  };
}
