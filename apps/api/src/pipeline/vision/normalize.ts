import {
  COVER_SCORE_RANGE,
  photoQualityIssueSchema,
  photoQualityRatingSchema,
  photoSubjectSchema,
  type EvidenceObject,
  type ObservationRejectionReason,
  type PhotoQualityIssue,
  type PhotoQualityRating,
  type PhotoSubject,
} from '@evidomo/shared';
import { OTHER_OBJECT, VISION_LIMITS, type RawPhotoClassification } from './schema.ts';

// Deterministic checks on one photo's Spark answer. Model output is untrusted: values outside
// the closed sets fail the photo, numbers are repaired only where the repair is unambiguous
// (rounding and clamping a score or count), and observation names must be safe fact-key slugs.

/** `snake_case` names after `other:` (the same rule as fact extraction's `other:` keys). */
const SLUG = /^[a-z][a-z0-9_]{0,63}$/;
const OTHER_PREFIX = 'other:';
const MAX_SUMMARY = 300;
const MAX_DETAIL = 200;
const MAX_OTHER_SUBJECT = 60;
const MAX_REJECTED_TEXT = 120;

export interface NormalizedObservation {
  /** `other:<evidence object id>` or `other:<model slug>`; unique within the photo. */
  readonly key: string;
  /** The evidence object ID, or `other`. */
  readonly object: string;
  readonly label: string;
  readonly detail: string;
  readonly modelCount: number;
  readonly supports: readonly string[];
  /** The SAM phrase for a configured evidence object; null for `other` observations. */
  readonly phrase: string | null;
  /** Position of the evidence object in the market list (its priority); null for `other`. */
  readonly priority: number | null;
}

export interface NormalizedClassification {
  readonly subject: PhotoSubject;
  readonly otherSubject: string | null;
  readonly summary: string;
  readonly quality: PhotoQualityRating;
  readonly qualityIssues: readonly PhotoQualityIssue[];
  readonly coverScore: number;
  readonly repairs: readonly string[];
  readonly observations: readonly NormalizedObservation[];
  /** Privacy phrases Spark reported as visible (de-duplicated, configured phrases only). */
  readonly privacySubjects: ReadonlySet<string>;
  readonly rejected: readonly { reason: ObservationRejectionReason; object: string }[];
}

export class ClassificationValueError extends Error {
  override name = 'ClassificationValueError';
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** `Built-in wardrobe` → `built_in_wardrobe`; undefined when no valid slug remains. */
export function toSlug(name: string): string | undefined {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return SLUG.test(slug) ? slug : undefined;
}

function humanize(slug: string): string {
  const words = slug.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function integerIn(value: number, min: number, max: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Validates one answer against the market's evidence objects and the step's privacy phrases.
 * Throws {@link ClassificationValueError} when a field outside the closed sets (subject, quality)
 * or a non-numeric cover score makes the whole answer unusable.
 */
export function normalizeClassification(
  raw: RawPhotoClassification,
  evidenceObjects: readonly EvidenceObject[],
  privacyPhrases: readonly string[],
): NormalizedClassification {
  const repairs: string[] = [];
  const subject = photoSubjectSchema.safeParse(raw.subject);
  const quality = photoQualityRatingSchema.safeParse(raw.quality);
  if (!subject.success) throw new ClassificationValueError('Unknown photo subject');
  if (!quality.success) throw new ClassificationValueError('Unknown photo quality');

  let otherSubject: string | null = null;
  if (subject.data === 'other') {
    const name = raw.otherSubject === null ? '' : clip(raw.otherSubject, MAX_OTHER_SUBJECT);
    otherSubject = name === '' ? null : name;
  } else if (raw.otherSubject !== null && raw.otherSubject.trim() !== '') {
    repairs.push('other_subject');
  }

  let summary = clip(raw.summary, MAX_SUMMARY);
  if (summary === '') {
    summary = humanize(subject.data);
    repairs.push('summary');
  }

  const issues = new Set<PhotoQualityIssue>();
  for (const issue of raw.qualityIssues) {
    const parsed = photoQualityIssueSchema.safeParse(issue);
    if (parsed.success) issues.add(parsed.data);
    else repairs.push('quality_issues');
  }

  const coverScore = integerIn(raw.coverScore, COVER_SCORE_RANGE.min, COVER_SCORE_RANGE.max);
  if (coverScore === undefined) throw new ClassificationValueError('Cover score is not a number');
  if (coverScore !== raw.coverScore) repairs.push('cover_score');

  const objectsById = new Map(evidenceObjects.map((item, index) => [item.id, { item, index }]));
  const observations: NormalizedObservation[] = [];
  const rejected: { reason: ObservationRejectionReason; object: string }[] = [];
  const seen = new Set<string>();
  for (const observation of raw.observations) {
    const named =
      observation.object === OTHER_OBJECT
        ? clip(observation.otherObject ?? '', MAX_REJECTED_TEXT)
        : observation.object;
    // An `other` name that equals a configured object is that object (it then gets evidence).
    const slug = observation.object === OTHER_OBJECT ? toSlug(named) : observation.object;
    const configured = slug === undefined ? undefined : objectsById.get(slug);
    if (slug === undefined || (observation.object !== OTHER_OBJECT && configured === undefined)) {
      rejected.push({ reason: 'invalid_other_name', object: named });
      continue;
    }
    const countValue = integerIn(observation.count, 0, VISION_LIMITS.maxObservationCount);
    if (countValue === undefined || countValue < 1) {
      rejected.push({ reason: 'invalid_count', object: slug });
      continue;
    }
    const key = `${OTHER_PREFIX}${slug}`;
    if (seen.has(key)) {
      rejected.push({ reason: 'duplicate', object: slug });
      continue;
    }
    if (observations.length >= VISION_LIMITS.maxObservationsPerPhoto) {
      rejected.push({ reason: 'too_many', object: slug });
      continue;
    }
    seen.add(key);
    if (countValue !== observation.count) repairs.push('observation_count');
    const label = configured?.item.label ?? humanize(slug);
    const detail = clip(observation.detail, MAX_DETAIL);
    observations.push({
      key,
      object: configured === undefined ? OTHER_OBJECT : configured.item.id,
      label,
      detail: detail === '' ? label : detail,
      modelCount: countValue,
      supports: configured?.item.supports ?? [],
      phrase: configured?.item.phrase ?? null,
      priority: configured?.index ?? null,
    });
  }

  const allowed = new Set(privacyPhrases);
  const privacySubjects = new Set(raw.privacySubjects.filter((phrase) => allowed.has(phrase)));

  return {
    subject: subject.data,
    otherSubject,
    summary,
    quality: quality.data,
    qualityIssues: [...issues],
    coverScore,
    repairs: [...new Set(repairs)],
    observations,
    privacySubjects,
    rejected,
  };
}
