import {
  integrityVerdictSchema,
  type IntegrityAttempt,
  type IntegrityOutcome,
  type IntegritySegmentation,
  type PhotoFailureReason,
  type StagedImageContent,
  type StagingOperationId,
} from '@evidomo/shared';
import type { MetaClients } from '../../meta/clients.ts';
import { SAM_REASONING_EFFORT, segmentImage } from '../../meta/sam.ts';
import type { StepConfig } from '../../runs/steps.ts';
import { stagingOperation } from '../staging/operations.ts';
import {
  stagePhoto,
  type StagedImageDraft,
  type StageOutcome,
  type StagingDeps,
  type StagingPhoto,
  type StagingSettings,
} from '../staging/stage.ts';
import { mapLimited } from '../vision/concurrency.ts';
import { photoOutcome, type PhotoOutcome } from '../vision/errors.ts';
import type { Meter } from '../vision/inventory.ts';
import {
  compareFixedElements,
  IntegrityInputError,
  type FixedElementRule,
  type IntegrityThresholds,
  type IntegrityVerdict,
} from './compare.ts';

// The model-facing core of the integrity step (docs/architecture.md §5, step 7): per staged
// photo, segment the original's fixed elements once, segment the edit, compare, and on failure
// re-run the same declared operation once and check that image against the same original
// segmentation. Independent of the database and storage, so the replay tests drive it directly.

/** Photos checked at once; each may wait ~10-20 s on its retry edit (P1-06). */
export const INTEGRITY_PHOTO_CONCURRENCY = 2;
/** SAM calls in flight per photo (at most 8 across the step), as in vision (P2-08). */
export const INTEGRITY_SEGMENT_CONCURRENCY = 4;

export interface IntegritySettings {
  readonly segmentationModel: string;
  readonly elements: readonly FixedElementRule[];
  readonly thresholds: IntegrityThresholds;
  readonly editPrivacyPhrases: readonly string[];
}

export function integritySettings(step: StepConfig<'integrity_checker'>): IntegritySettings {
  return {
    segmentationModel: step.segmentation_model,
    elements: step.fixed_elements.map((element) => ({
      label: element.phrase,
      occlusionTolerant: element.occlusion_tolerant,
    })),
    thresholds: {
      minIoU: step.min_iou,
      minContainment: step.min_containment,
      minAreaRatio: step.min_area_ratio,
      maxAspectRatioChange: step.max_aspect_ratio_change,
    },
    editPrivacyPhrases: step.edit_privacy_phrases,
  };
}

/**
 * Re-runs a staged photo's declared operation (the one retry). The default sends exactly the
 * staging step's request again (`stagePhoto`: same operation, prompt, size, tools-off body);
 * integration tests substitute images whose SAM answers are recorded.
 */
export type Restage = (
  deps: StagingDeps,
  settings: StagingSettings,
  photo: StagingPhoto,
  operationId: StagingOperationId,
) => Promise<StageOutcome>;

export const restageSameOperation: Restage = (deps, settings, photo, operationId) =>
  stagePhoto(deps, settings, photo, stagingOperation(operationId));

export interface IntegrityDeps {
  readonly clients: MetaClients;
  /** `ctx.ledger.meter` in the step; tests pass a pass-through. */
  readonly meter: Meter;
  readonly signal?: AbortSignal;
  readonly restage: Restage;
  /** The staging step's settings: the retry uses its image model. */
  readonly staging: StagingSettings;
}

/** One staged photo: the original (read and checked by the caller) and the image to check. */
export interface IntegrityJob {
  readonly original: StagingPhoto;
  readonly stagedArtifactId: string;
  readonly staged: StagedImageContent;
  /** The stored staged JPEG. */
  readonly stagedBytes: Uint8Array;
}

/** Attempt 2's image before it is stored; its artifact ID is assigned at commit. */
export const PENDING_RETRY_ARTIFACT_ID = 'pending-retry';

export interface IntegrityPhotoResult {
  readonly materialId: string;
  readonly operationId: StagingOperationId;
  readonly original: IntegritySegmentation | null;
  /** Attempt 2's `stagedArtifactId` is {@link PENDING_RETRY_ARTIFACT_ID} until stored. */
  readonly attempts: readonly IntegrityAttempt[];
  readonly outcome: IntegrityOutcome;
  /** The retry's image, whatever its verdict (stored for audit; final only if it passed). */
  readonly retry: StagedImageDraft | undefined;
}

type Segmentation = PhotoOutcome<IntegritySegmentation>;

/**
 * Segments one image for every phrase. A photo-level SAM failure on any phrase makes the whole
 * image unchecked (fail-closed); any other error propagates to the engine.
 */
async function segmentPhrases(
  deps: IntegrityDeps,
  settings: IntegritySettings,
  image: Uint8Array,
  phrases: readonly string[],
): Promise<Segmentation> {
  const results = await mapLimited(phrases, INTEGRITY_SEGMENT_CONCURRENCY, (phrase) =>
    deps.meter(settings.segmentationModel, () =>
      photoOutcome(() =>
        segmentImage(deps.clients, {
          modelId: settings.segmentationModel,
          phrase,
          image,
          reasoningEffort: SAM_REASONING_EFFORT,
          ...(deps.signal === undefined ? {} : { abortSignal: deps.signal }),
        }),
      ),
    ),
  );
  const failed = results.find((r) => !r.ok);
  if (failed !== undefined && !failed.ok) return failed;
  const segments: Record<string, IntegritySegmentation['segments'][string]> = {};
  let size: { width: number; height: number } | undefined;
  for (const result of results) {
    if (!result.ok) continue;
    size ??= { width: result.value.image.width, height: result.value.image.height };
    segments[result.value.phrase] = result.value.segments.map((s) => ({
      box: { x0: s.box.x0, y0: s.box.y0, x1: s.box.x1, y1: s.box.y1 },
      score: s.score ?? null,
    }));
  }
  if (size === undefined) throw new Error('segmentPhrases: no phrases');
  return { ok: true, value: { ...size, segments } };
}

type CheckedAttempt = Extract<IntegrityAttempt, { status: 'checked' | 'unchecked' }>;

async function checkEdit(
  deps: IntegrityDeps,
  settings: IntegritySettings,
  original: IntegritySegmentation,
  attempt: 1 | 2,
  stagedArtifactId: string,
  bytes: Uint8Array,
): Promise<CheckedAttempt> {
  const phrases = [...settings.elements.map((e) => e.label), ...settings.editPrivacyPhrases];
  const edit = await segmentPhrases(deps, settings, bytes, phrases);
  if (!edit.ok) {
    return { status: 'unchecked', attempt, stagedArtifactId, target: 'edit', reason: edit.reason };
  }
  return judge(settings, original, edit.value, attempt, stagedArtifactId);
}

/** The comparison of one segmented edit; exported for tests that vary settings. */
export function judge(
  settings: IntegritySettings,
  original: IntegritySegmentation,
  edit: IntegritySegmentation,
  attempt: 1 | 2,
  stagedArtifactId: string,
): CheckedAttempt {
  let verdict: IntegrityVerdict;
  try {
    verdict = compareFixedElements(original, edit, {
      thresholds: settings.thresholds,
      elements: settings.elements,
    });
  } catch (error) {
    // Settings are validated at boot, so this is a box SAM reported outside its own image:
    // the model's output is unusable for this photo, which then keeps its original.
    if (error instanceof IntegrityInputError) {
      return {
        status: 'unchecked',
        attempt,
        stagedArtifactId,
        target: 'edit',
        reason: 'invalid_output',
      };
    }
    throw error;
  }
  const phrases = settings.editPrivacyPhrases.map((phrase) => ({
    phrase,
    count: edit.segments[phrase]?.length ?? 0,
  }));
  const privacy = { passed: phrases.every((p) => p.count === 0), phrases };
  return {
    status: 'checked',
    attempt,
    stagedArtifactId,
    passed: verdict.passed && privacy.passed,
    edit,
    // Parsed rather than cast: the stored record must match the shared contract exactly.
    verdict: integrityVerdictSchema.parse(verdict),
    privacy,
  };
}

function outcomeOf(attempts: readonly IntegrityAttempt[]): IntegrityOutcome {
  const last = attempts.at(-1);
  if (last?.status !== 'checked' || !last.passed) return 'fallback_original';
  return last.attempt === 1 ? 'passed' : 'passed_on_retry';
}

/** Checks one staged photo: at most one retry, then the original only. */
export async function checkStagedPhoto(
  deps: IntegrityDeps,
  settings: IntegritySettings,
  job: IntegrityJob,
): Promise<IntegrityPhotoResult> {
  const base = { materialId: job.original.materialId, operationId: job.staged.operation.id };
  const finish = (
    original: IntegritySegmentation | null,
    attempts: IntegrityAttempt[],
    retry?: StagedImageDraft,
  ): IntegrityPhotoResult => ({
    ...base,
    original,
    attempts,
    outcome: outcomeOf(attempts),
    retry,
  });

  // The original and the first edit are segmented together: the original fails rarely, and
  // waiting for it first would double the latency of every photo.
  const fixedPhrases = settings.elements.map((e) => e.label);
  // allSettled: when one side throws, the other side's calls are still awaited (and metered)
  // before the error propagates, as `mapLimited` does.
  const [originalSettled, firstSettled] = await Promise.allSettled([
    segmentPhrases(deps, settings, job.original.bytes, fixedPhrases),
    segmentPhrases(deps, settings, job.stagedBytes, [
      ...fixedPhrases,
      ...settings.editPrivacyPhrases,
    ]),
  ]);
  if (originalSettled.status === 'rejected') throw originalSettled.reason;
  if (firstSettled.status === 'rejected') throw firstSettled.reason;
  const original = originalSettled.value;
  const first = firstSettled.value;
  if (!original.ok) {
    return finish(null, [unchecked(1, job.stagedArtifactId, 'original', original.reason)]);
  }
  const attempt1: CheckedAttempt = first.ok
    ? judge(settings, original.value, first.value, 1, job.stagedArtifactId)
    : unchecked(1, job.stagedArtifactId, 'edit', first.reason);
  // Only a failed verdict is retried: an unchecked edit would most likely stay unchecked, and
  // a retry edit costs more than the check.
  if (attempt1.status !== 'checked' || attempt1.passed) return finish(original.value, [attempt1]);

  const retry = await deps.restage(
    {
      clients: deps.clients,
      meter: deps.meter,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
    deps.staging,
    job.original,
    job.staged.operation.id,
  );
  if (!retry.ok) {
    return finish(original.value, [
      attempt1,
      { status: 'edit_failed', attempt: 2, reason: retry.reason },
    ]);
  }
  const attempt2 = await checkEdit(
    deps,
    settings,
    original.value,
    2,
    PENDING_RETRY_ARTIFACT_ID,
    retry.value.encoded.bytes,
  );
  return finish(original.value, [attempt1, attempt2], retry.value);
}

function unchecked(
  attempt: 1 | 2,
  stagedArtifactId: string,
  target: 'original' | 'edit',
  reason: PhotoFailureReason,
): CheckedAttempt {
  return { status: 'unchecked', attempt, stagedArtifactId, target, reason };
}

/**
 * Checks every staged photo, at most {@link INTEGRITY_PHOTO_CONCURRENCY} at once. After the
 * first error that is not a photo failure no new photo starts; running ones are awaited.
 */
export function runIntegrityChecks(
  deps: IntegrityDeps,
  settings: IntegritySettings,
  jobs: readonly IntegrityJob[],
): Promise<IntegrityPhotoResult[]> {
  return mapLimited(jobs, INTEGRITY_PHOTO_CONCURRENCY, (job) =>
    checkStagedPhoto(deps, settings, job),
  );
}
