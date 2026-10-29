import {
  FURNISHING_STATES,
  PHOTO_QUALITY_ISSUES,
  PHOTO_QUALITY_RATINGS,
  PHOTO_SUBJECTS,
  type EvidenceObject,
} from '@evidomo/shared';
import { z } from 'zod';

// Vision inventory contracts (docs/architecture.md §5 step 3). Spark sees one photo per call and
// answers in strict `json_schema` mode; `normalize.ts` re-checks every field in code, because
// strict mode constrains the shape of the answer, not its truth.

/** Structured-output name sent to the API (part of the fixture's request hash). */
export const PHOTO_CLASSIFICATION_OUTPUT_NAME = 'photo_inventory';
/**
 * Bumped whenever the prompt or output schema changes meaning; stored in the artifact.
 * 2: `furnishing` (empty / partly / furnished) for interior rooms.
 */
export const VISION_PROMPT_VERSION = 2;

/** The model's object ID for anything outside the market's evidence objects. */
export const OTHER_OBJECT = 'other';

/** Bounds applied in code (strict mode is not relied on for `maxItems`). */
export const VISION_LIMITS = {
  /** Observations kept per photo; the rest are rejected as `too_many`. */
  maxObservationsPerPhoto: 15,
  /** Upper bound on a per-photo instance count (a count beyond it is clamped). */
  maxObservationCount: 99,
  /** Model calls in flight at once across the step (Spark and SAM together). */
  concurrency: 4,
} as const;

function enumOf(values: readonly string[]): z.ZodEnum<Record<string, string>> {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('An output enum needs at least one value');
  return z.enum([first, ...rest]);
}

/**
 * The strict output schema for one photo. Every field is required and nullable where absent
 * (Meta enforces strict `json_schema` server-side; `.optional()` is rejected). Ranges, counts,
 * and name formats are checked in code.
 */
export function buildPhotoOutputSchema(
  evidenceObjects: readonly EvidenceObject[],
  privacyPhrases: readonly string[],
) {
  const observation = z.object({
    object: enumOf([...evidenceObjects.map((item) => item.id), OTHER_OBJECT]),
    otherObject: z
      .string()
      .nullable()
      .describe('snake_case English name when object is "other", else null'),
    count: z.number().describe('how many instances are clearly visible in this photo'),
    detail: z.string().describe('short factual English phrase about what is visible'),
  });
  return z.object({
    subject: z.enum(PHOTO_SUBJECTS),
    otherSubject: z
      .string()
      .nullable()
      .describe('short English name when subject is "other", else null'),
    furnishing: z
      .enum(FURNISHING_STATES)
      .nullable()
      .describe('movable furniture in an interior room; null for exteriors, plans, documents'),
    summary: z.string().describe('one short factual English sentence'),
    quality: z.enum(PHOTO_QUALITY_RATINGS),
    qualityIssues: z.array(z.enum(PHOTO_QUALITY_ISSUES)),
    coverScore: z.number().describe('integer 1-10: suitability as the listing cover photo'),
    observations: z.array(observation),
    privacySubjects: z
      .array(enumOf(privacyPhrases))
      .describe('every listed privacy subject visible anywhere in the photo'),
  });
}

export type PhotoOutputSchema = ReturnType<typeof buildPhotoOutputSchema>;

/**
 * One photo's answer as the model returned it, typed loosely on purpose: normalization must cope
 * with any value in any field, whatever the schema promised.
 */
export interface RawPhotoClassification {
  readonly subject: string;
  readonly otherSubject: string | null;
  readonly furnishing: string | null;
  readonly summary: string;
  readonly quality: string;
  readonly qualityIssues: readonly string[];
  readonly coverScore: number;
  readonly observations: readonly {
    readonly object: string;
    readonly otherObject: string | null;
    readonly count: number;
    readonly detail: string;
  }[];
  readonly privacySubjects: readonly string[];
}
