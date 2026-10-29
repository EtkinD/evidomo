import {
  type EvidenceObject,
  type ImageRegion,
  type InventoryPhoto,
  type MarketProfile,
  type MetaReasoningEffort,
  type PhotoInventoryContent,
  type PrivacyStatus,
  type SamRegion,
  type StoredObservation,
} from '@evidomo/shared';
import { generateText, Output } from 'ai';
import type { MetaClients } from '../../meta/clients.ts';
import { metaProviderOptions } from '../../meta/options.ts';
import { SAM_REASONING_EFFORT, segmentImage, type SamSegment } from '../../meta/sam.ts';
import { NonRetryableStepError, type StepConfig } from '../../runs/steps.ts';
import { mapLimited } from './concurrency.ts';
import { imageForClassification } from './downscale.ts';
import { photoOutcome, type PhotoOutcome } from './errors.ts';
import { normalizeClassification, type NormalizedClassification } from './normalize.ts';
import { buildPhotoSystemPrompt, PHOTO_USER_TEXT } from './prompt.ts';
import { toRegion, toStoredRegion, unionBox, WHOLE_IMAGE } from './regions.ts';
import {
  PHOTO_CLASSIFICATION_OUTPUT_NAME,
  VISION_LIMITS,
  VISION_PROMPT_VERSION,
  buildPhotoOutputSchema,
  type PhotoOutputSchema,
  type RawPhotoClassification,
} from './schema.ts';
import {
  allocateEvidenceMasks,
  rankCovers,
  selectEvidenceRequests,
  type EvidenceCandidate,
} from './selection.ts';

// The model-facing core of step 3 (docs/architecture.md §5), independent of the database so the
// replay test drives it directly. Per photo: one Spark classification and one SAM call per
// privacy phrase (always, uncapped); then, across the run, at most `max_evidence_masks` SAM
// evidence requests for objects Spark reported. Every call goes through the caller's `meter`.

export type PhotoMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

/** One stored photo, read and checked by the handler. */
export interface VisionPhoto {
  readonly materialId: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly mediaType: PhotoMediaType;
  readonly width: number;
  readonly height: number;
}

/** Everything the step's model calls depend on; models, effort, and caps come from the step. */
export interface VisionSettings {
  readonly modelId: string;
  readonly reasoningEffort: MetaReasoningEffort;
  readonly maxOutputTokens: number;
  readonly segmentationModel: string;
  readonly maxEvidenceMasks: number;
  /** Spark sees photos downscaled to this long edge; SAM gets the stored photo. */
  readonly classificationLongEdgePx: number;
  readonly privacyPhrases: readonly string[];
  readonly evidenceObjects: readonly EvidenceObject[];
  readonly system: string;
  readonly schema: PhotoOutputSchema;
}

export function visionSettings(step: StepConfig<'vision'>, market: MarketProfile): VisionSettings {
  return {
    modelId: step.model,
    reasoningEffort: step.reasoning_effort,
    maxOutputTokens: step.max_output_tokens,
    segmentationModel: step.segmentation_model,
    maxEvidenceMasks: step.max_evidence_masks,
    classificationLongEdgePx: step.classification_long_edge_px,
    privacyPhrases: step.privacy_phrases,
    evidenceObjects: market.evidence_objects,
    system: buildPhotoSystemPrompt(market.evidence_objects, step.privacy_phrases),
    schema: buildPhotoOutputSchema(market.evidence_objects, step.privacy_phrases),
  };
}

export interface PhotoClassificationCall {
  readonly classification: RawPhotoClassification;
  readonly finishReason: string;
  /** Only with `includeResponseBody` (tests assert what Meta echoes). */
  readonly responseBody: unknown;
}

/**
 * One Spark call for one photo, strict `json_schema`. The SDK validates the answer against the
 * zod schema (throwing `NoObjectGeneratedError` otherwise); usage is recorded by the clients'
 * call hook. Callers inside a step wrap this in `ctx.ledger.meter`.
 */
export async function callPhotoClassification(
  clients: MetaClients,
  settings: VisionSettings,
  photo: Pick<VisionPhoto, 'bytes' | 'mediaType'>,
  options: { readonly signal?: AbortSignal; readonly includeResponseBody?: boolean } = {},
): Promise<PhotoClassificationCall> {
  const result = await generateText({
    model: clients.languageModel(settings.modelId),
    system: settings.system,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PHOTO_USER_TEXT },
          { type: 'file', mediaType: photo.mediaType, data: { type: 'data', data: photo.bytes } },
        ],
      },
    ],
    output: Output.object({ schema: settings.schema, name: PHOTO_CLASSIFICATION_OUTPUT_NAME }),
    maxOutputTokens: settings.maxOutputTokens,
    providerOptions: metaProviderOptions({ reasoningEffort: settings.reasoningEffort }),
    include: { responseBody: options.includeResponseBody ?? false },
    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    ...clients.aiSdkCallOptions(),
  });
  return {
    classification: result.output,
    finishReason: result.finishReason,
    responseBody: result.response.body,
  };
}

export type Meter = <T>(modelId: string, call: () => Promise<T>) => Promise<T>;

export interface VisionRunDeps {
  readonly clients: MetaClients;
  /** `ctx.ledger.meter` in the step; tests pass a pass-through. */
  readonly meter: Meter;
  readonly signal?: AbortSignal;
}

/** A `photo_region` candidate fact, before the artifact ID it cites is known. */
export interface PhotoFactDraft {
  readonly materialId: string;
  readonly key: string;
  /** Instances visible: SAM's count when segmented, else Spark's. */
  readonly value: number;
  readonly region: ImageRegion;
  /** The observation has stored masks, so the fact cites the inventory artifact. */
  readonly hasMask: boolean;
}

export interface VisionInventoryResult {
  readonly content: PhotoInventoryContent;
  readonly facts: readonly PhotoFactDraft[];
}

type SegmentOutcome = PhotoOutcome<readonly SamSegment[]>;

function segment(
  deps: VisionRunDeps,
  settings: VisionSettings,
  photo: VisionPhoto,
  phrase: string,
): Promise<SegmentOutcome> {
  return deps.meter(settings.segmentationModel, () =>
    photoOutcome(async () => {
      const result = await segmentImage(deps.clients, {
        modelId: settings.segmentationModel,
        phrase,
        image: photo.bytes,
        reasoningEffort: SAM_REASONING_EFFORT,
        ...(deps.signal === undefined ? {} : { abortSignal: deps.signal }),
      });
      return result.segments;
    }),
  );
}

async function classify(
  deps: VisionRunDeps,
  settings: VisionSettings,
  photo: VisionPhoto,
): Promise<PhotoOutcome<NormalizedClassification>> {
  const image = await imageForClassification(photo, settings.classificationLongEdgePx);
  return deps.meter(settings.modelId, () =>
    photoOutcome(async () => {
      const call = await callPhotoClassification(deps.clients, settings, image, {
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      return normalizeClassification(
        call.classification,
        settings.evidenceObjects,
        settings.privacyPhrases,
      );
    }),
  );
}

type PrivacyPhraseResult = InventoryPhoto['privacy']['phrases'][number];

/** Precedence: an unchecked phrase, then a disagreement, then any region. */
export function privacyStatusOf(phrases: readonly PrivacyPhraseResult[]): PrivacyStatus {
  if (phrases.some((p) => p.status === 'failed')) return 'failed';
  if (phrases.some((p) => p.status === 'checked' && p.regions.length === 0 && p.modelSaw === true))
    return 'review';
  if (phrases.some((p) => p.status === 'checked' && p.regions.length > 0)) return 'masked';
  return 'clear';
}

type Phase1Task =
  | { readonly kind: 'classify'; readonly photoIndex: number }
  | { readonly kind: 'privacy'; readonly photoIndex: number; readonly phrase: string };

type Phase1Result =
  | { readonly kind: 'classify'; readonly outcome: PhotoOutcome<NormalizedClassification> }
  | { readonly kind: 'privacy'; readonly outcome: SegmentOutcome };

export async function runVisionInventory(
  deps: VisionRunDeps,
  settings: VisionSettings,
  photos: readonly VisionPhoto[],
): Promise<VisionInventoryResult> {
  const photoAt = (index: number): VisionPhoto => {
    const photo = photos[index];
    if (photo === undefined) throw new Error(`No photo at index ${index}`);
    return photo;
  };

  // Phase 1: classification and privacy segmentation for every photo.
  const phase1: Phase1Task[] = photos.flatMap((_, photoIndex) => [
    { kind: 'classify' as const, photoIndex },
    ...settings.privacyPhrases.map((phrase) => ({
      kind: 'privacy' as const,
      photoIndex,
      phrase,
    })),
  ]);
  const phase1Results = await mapLimited(
    phase1,
    VISION_LIMITS.concurrency,
    async (task): Promise<Phase1Result> =>
      task.kind === 'classify'
        ? { kind: 'classify', outcome: await classify(deps, settings, photoAt(task.photoIndex)) }
        : {
            kind: 'privacy',
            outcome: await segment(deps, settings, photoAt(task.photoIndex), task.phrase),
          },
  );
  const classifications = new Map<number, PhotoOutcome<NormalizedClassification>>();
  const privacy = new Map<string, SegmentOutcome>();
  phase1.forEach((task, i) => {
    const result = phase1Results[i];
    if (result === undefined) throw new Error(`Missing result for task ${i}`);
    if (task.kind === 'classify' && result.kind === 'classify') {
      classifications.set(task.photoIndex, result.outcome);
    } else if (task.kind === 'privacy' && result.kind === 'privacy') {
      privacy.set(`${task.photoIndex}:${task.phrase}`, result.outcome);
    }
  });
  const classificationOf = (index: number): PhotoOutcome<NormalizedClassification> => {
    const outcome = classifications.get(index);
    if (outcome === undefined) throw new Error(`Missing classification for photo ${index}`);
    return outcome;
  };

  if (photos.every((_, index) => !classificationOf(index).ok)) {
    throw new NonRetryableStepError(
      `Photo classification failed for all ${photos.length} photo(s); the inventory would be empty`,
    );
  }
  const privacyFailedEverywhere = photos.every((_, index) =>
    settings.privacyPhrases.some((phrase) => privacy.get(`${index}:${phrase}`)?.ok !== true),
  );
  if (privacyFailedEverywhere) {
    throw new NonRetryableStepError(
      `Privacy segmentation failed on all ${photos.length} photo(s); no photo is privacy-checked`,
    );
  }

  // Phase 2: evidence segmentation, at most `maxEvidenceMasks` requests across the run.
  const candidates: EvidenceCandidate[] = photos.flatMap((_, photoIndex) => {
    const outcome = classificationOf(photoIndex);
    if (!outcome.ok) return [];
    return outcome.value.observations.flatMap((observation) =>
      observation.phrase === null || observation.priority === null
        ? []
        : [
            {
              photoIndex,
              key: observation.key,
              phrase: observation.phrase,
              priority: observation.priority,
              quality: outcome.value.quality,
            },
          ],
    );
  });
  const requests = selectEvidenceRequests(candidates, settings.maxEvidenceMasks);
  const evidenceResults = await mapLimited(requests, VISION_LIMITS.concurrency, (request) =>
    segment(deps, settings, photoAt(request.photoIndex), request.phrase),
  );
  const keptMasks = allocateEvidenceMasks(
    evidenceResults.map((outcome) => (outcome.ok ? outcome.value.map((s) => s.score) : [])),
    settings.maxEvidenceMasks,
  );
  const requestIndex = new Map(
    requests.map((request, i) => [`${request.photoIndex}:${request.key}`, i]),
  );

  const coverRanks = rankCovers(
    photos.flatMap((_, photoIndex) => {
      const outcome = classificationOf(photoIndex);
      return outcome.ok
        ? [
            {
              photoIndex,
              coverScore: outcome.value.coverScore,
              quality: outcome.value.quality,
              issueCount: outcome.value.qualityIssues.length,
            },
          ]
        : [];
    }),
  );

  // Assembly.
  const facts: PhotoFactDraft[] = [];
  const rejected: PhotoInventoryContent['rejected'] = [];
  let maskCount = 0;
  let regionCount = 0;
  const inventoryPhotos: InventoryPhoto[] = photos.map((photo, photoIndex) => {
    const outcome = classificationOf(photoIndex);
    const phrases: PrivacyPhraseResult[] = settings.privacyPhrases.map((phrase) => {
      const result = privacy.get(`${photoIndex}:${phrase}`);
      if (result === undefined) throw new Error(`Missing privacy result for photo ${photoIndex}`);
      const modelSaw = outcome.ok ? outcome.value.privacySubjects.has(phrase) : null;
      return result.ok
        ? {
            status: 'checked',
            phrase,
            modelSaw,
            regions: result.value.map((s) => toStoredRegion(s, photo.width, photo.height, true)),
          }
        : { status: 'failed', phrase, modelSaw, reason: result.reason };
    });

    if (!outcome.ok) {
      return {
        materialId: photo.materialId,
        materialSha256: photo.sha256,
        width: photo.width,
        height: photo.height,
        classification: { status: 'failed', reason: outcome.reason },
        privacy: { status: privacyStatusOf(phrases), phrases },
        observations: [],
      };
    }
    const value = outcome.value;
    for (const item of value.rejected) {
      rejected.push({ materialId: photo.materialId, reason: item.reason, object: item.object });
    }

    const observations: StoredObservation[] = value.observations.map((observation) => {
      const base = {
        key: observation.key,
        object: observation.object,
        label: observation.label,
        detail: observation.detail,
        modelCount: observation.modelCount,
        supports: [...observation.supports],
      };
      const r = requestIndex.get(`${photoIndex}:${observation.key}`);
      const result = r === undefined ? undefined : evidenceResults[r];
      let evidence: StoredObservation['evidence'];
      let region: ImageRegion = WHOLE_IMAGE;
      let factValue = observation.modelCount;
      let hasMask = false;
      if (observation.phrase === null) {
        evidence = {
          status: 'not_segmentable',
          phrase: null,
          instanceCount: null,
          regions: [],
          reason: null,
        };
      } else if (r === undefined || result === undefined) {
        evidence = {
          status: 'not_requested',
          phrase: null,
          instanceCount: null,
          regions: [],
          reason: null,
        };
      } else if (!result.ok) {
        evidence = {
          status: 'failed',
          phrase: observation.phrase,
          instanceCount: null,
          regions: [],
          reason: result.reason,
        };
      } else if (result.value.length === 0) {
        evidence = {
          status: 'not_found',
          phrase: observation.phrase,
          instanceCount: 0,
          regions: [],
          reason: null,
        };
      } else {
        const regions: SamRegion[] = result.value.map((s, i) =>
          toStoredRegion(s, photo.width, photo.height, keptMasks.has(`${r}:${i}`)),
        );
        const union = unionBox(result.value.map((s) => s.box));
        if (union !== undefined) region = toRegion(union, photo.width, photo.height);
        hasMask = regions.some((stored) => stored.mask !== null);
        maskCount += regions.filter((stored) => stored.mask !== null).length;
        regionCount += regions.length;
        factValue = result.value.length;
        evidence = {
          status: 'segmented',
          phrase: observation.phrase,
          instanceCount: result.value.length,
          regions,
          reason: null,
        };
      }
      const factStored = evidence.status !== 'not_found';
      if (factStored) {
        facts.push({
          materialId: photo.materialId,
          key: observation.key,
          value: factValue,
          region,
          hasMask,
        });
      }
      return { ...base, evidence, region, factStored };
    });

    const coverRank = coverRanks.get(photoIndex);
    if (coverRank === undefined) throw new Error(`Missing cover rank for photo ${photoIndex}`);
    return {
      materialId: photo.materialId,
      materialSha256: photo.sha256,
      width: photo.width,
      height: photo.height,
      classification: {
        status: 'ok',
        subject: value.subject,
        otherSubject: value.otherSubject,
        furnishing: value.furnishing,
        summary: value.summary,
        quality: value.quality,
        qualityIssues: [...value.qualityIssues],
        coverScore: value.coverScore,
        coverRank,
        repairs: [...value.repairs],
      },
      privacy: { status: privacyStatusOf(phrases), phrases },
      observations,
    };
  });

  const privacyCount = (status: PrivacyStatus): number =>
    inventoryPhotos.filter((photo) => photo.privacy.status === status).length;
  const classified = inventoryPhotos.filter((p) => p.classification.status === 'ok').length;
  const content: PhotoInventoryContent = {
    schemaVersion: 1,
    promptVersion: VISION_PROMPT_VERSION,
    model: settings.modelId,
    reasoningEffort: settings.reasoningEffort,
    maxOutputTokens: settings.maxOutputTokens,
    segmentationModel: settings.segmentationModel,
    privacyPhrases: [...settings.privacyPhrases],
    evidence: {
      cap: settings.maxEvidenceMasks,
      candidateCount: candidates.length,
      requestCount: requests.length,
      regionCount,
      maskCount,
    },
    counts: {
      photos: photos.length,
      classified,
      classificationFailed: photos.length - classified,
      privacy: {
        clear: privacyCount('clear'),
        masked: privacyCount('masked'),
        review: privacyCount('review'),
        failed: privacyCount('failed'),
      },
      privacyRegions: inventoryPhotos.reduce(
        (sum, photo) =>
          sum +
          photo.privacy.phrases.reduce(
            (n, p) => n + (p.status === 'checked' ? p.regions.length : 0),
            0,
          ),
        0,
      ),
      observations: inventoryPhotos.reduce((sum, photo) => sum + photo.observations.length, 0),
      facts: facts.length,
      rejectedObservations: rejected.length,
    },
    photos: inventoryPhotos,
    rejected,
  };
  return { content, facts };
}
