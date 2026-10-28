import type {
  InventoryPhoto,
  PhotoInventoryContent,
  PhotoSubject,
  StagingOperation,
  StagingOperationKind,
  StagingSkipReason,
} from '@evidomo/shared';
import {
  DECLUTTER_SUBJECTS,
  FURNISH_OPERATION_BY_SUBJECT,
  stagingOperation,
} from './operations.ts';

// Which photos the staging step edits, and with which declared operation. Pure and
// deterministic: the same inventory and cap give the same plan.
//
// Per photo, in this order:
// 1. Privacy: only `clear` photos are sent. `review` and `failed` are never sent to the image
//    model; `masked` photos are skipped in v1 because the original's privacy masks do not fit a
//    re-rendered image (the edit redraws the whole frame, P1-06), so the export could not blur a
//    staged copy reliably.
// 2. The classification must exist and the quality must not be `poor`.
// 3. Operation: a `cluttered` or `personal_items` interior is decluttered; otherwise a living
//    room, dining room, bedroom, or study is furnished; anything else is not stageable.
// 4. The operation's kind must be in the step's `operation_kinds`. A photo whose fitting
//    operation is disabled is skipped, never given another operation: furnishing a cluttered
//    room would stage around the clutter.
// Then across photos, best cover rank first: at most one furnished photo per subject (two
// independently furnished views of one room would show different furniture), and at most
// `maxStagedImages` edits.

export interface StagingRequestPlan {
  readonly materialId: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly coverRank: number;
  readonly operation: StagingOperation;
}

export type PlannedPhoto =
  | { readonly status: 'selected'; readonly request: StagingRequestPlan }
  | {
      readonly status: 'skipped';
      readonly materialId: string;
      readonly reason: StagingSkipReason;
      readonly operation: StagingOperation | null;
    };

export interface StagingPlan {
  /** One entry per inventoried photo, in inventory order. */
  readonly photos: readonly PlannedPhoto[];
  /** The selected requests, best cover rank first. */
  readonly requests: readonly StagingRequestPlan[];
  /** Photos that passed the privacy, quality, and operation rules. */
  readonly eligibleCount: number;
}

const DECLUTTER_ISSUES = new Set(['cluttered', 'personal_items']);

export function operationFor(
  subject: PhotoSubject,
  qualityIssues: readonly string[],
): StagingOperation | undefined {
  if (DECLUTTER_SUBJECTS.has(subject) && qualityIssues.some((i) => DECLUTTER_ISSUES.has(i))) {
    return stagingOperation('declutter');
  }
  const furnish = FURNISH_OPERATION_BY_SUBJECT[subject];
  return furnish === undefined ? undefined : stagingOperation(furnish);
}

type Assessment =
  | { readonly ok: false; readonly reason: StagingSkipReason }
  | {
      readonly ok: true;
      readonly subject: PhotoSubject;
      readonly request: StagingRequestPlan;
    };

function assess(
  photo: InventoryPhoto,
  operationKinds: ReadonlySet<StagingOperationKind>,
): Assessment {
  switch (photo.privacy.status) {
    case 'failed':
      return { ok: false, reason: 'privacy_failed' };
    case 'review':
      return { ok: false, reason: 'privacy_review' };
    case 'masked':
      return { ok: false, reason: 'privacy_masked' };
    case 'clear':
      break;
    default: {
      const unreachable: never = photo.privacy.status;
      throw new Error(`Unhandled privacy status ${String(unreachable)}`);
    }
  }
  const { classification } = photo;
  if (classification.status !== 'ok') return { ok: false, reason: 'classification_failed' };
  if (classification.quality === 'poor') return { ok: false, reason: 'poor_quality' };
  const operation = operationFor(classification.subject, classification.qualityIssues);
  if (operation === undefined) return { ok: false, reason: 'not_stageable' };
  if (!operationKinds.has(operation.kind)) return { ok: false, reason: 'operation_not_enabled' };
  return {
    ok: true,
    subject: classification.subject,
    request: {
      materialId: photo.materialId,
      sha256: photo.materialSha256,
      width: photo.width,
      height: photo.height,
      coverRank: classification.coverRank,
      operation,
    },
  };
}

export function planStaging(
  inventory: Pick<PhotoInventoryContent, 'photos'>,
  maxStagedImages: number,
  operationKinds: ReadonlySet<StagingOperationKind>,
): StagingPlan {
  const outcomes = new Map<string, PlannedPhoto>();
  const eligible: { subject: PhotoSubject; request: StagingRequestPlan }[] = [];
  for (const photo of inventory.photos) {
    const assessment = assess(photo, operationKinds);
    if (assessment.ok) {
      eligible.push(assessment);
    } else {
      outcomes.set(photo.materialId, {
        status: 'skipped',
        materialId: photo.materialId,
        reason: assessment.reason,
        operation: null,
      });
    }
  }

  // Cover ranks are unique among classified photos; the material ID only makes ties impossible.
  eligible.sort(
    (a, b) =>
      a.request.coverRank - b.request.coverRank ||
      a.request.materialId.localeCompare(b.request.materialId),
  );
  const furnished = new Set<PhotoSubject>();
  const requests: StagingRequestPlan[] = [];
  for (const { subject, request } of eligible) {
    const { materialId, operation } = request;
    if (operation.kind === 'furnish' && furnished.has(subject)) {
      outcomes.set(materialId, {
        status: 'skipped',
        materialId,
        reason: 'subject_already_furnished',
        operation,
      });
    } else if (requests.length >= maxStagedImages) {
      outcomes.set(materialId, { status: 'skipped', materialId, reason: 'cap_reached', operation });
    } else {
      requests.push(request);
      if (operation.kind === 'furnish') furnished.add(subject);
      outcomes.set(materialId, { status: 'selected', request });
    }
  }

  return {
    photos: inventory.photos.map((photo) => {
      const outcome = outcomes.get(photo.materialId);
      if (outcome === undefined) throw new Error('planStaging: a photo has no outcome');
      return outcome;
    }),
    requests,
    eligibleCount: eligible.length,
  };
}
