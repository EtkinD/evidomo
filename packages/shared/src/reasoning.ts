import { z } from 'zod';

/**
 * Reasoning efforts Meta accepts, as listed by the API's own 400 messages for `muse-spark-1.3`
 * (P1-02) and `muse-wonder-1.0` (P1-03): the same set for both, `none` is rejected
 * (docs/model-notes.md).
 *
 * Lives in `shared` because service definitions (validated here) carry per-step efforts; the
 * api's meta module re-exports it for its call options.
 */
export const META_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type MetaReasoningEffort = (typeof META_REASONING_EFFORTS)[number];

export const metaReasoningEffortSchema = z.enum(META_REASONING_EFFORTS);
