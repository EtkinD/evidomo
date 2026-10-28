import { z } from 'zod';
import { validatorResultSchema } from './domain.ts';

// The code-level claim validator's report (docs/architecture.md §6 step 2, §5 "Claim validator
// (P3-02)"). Shared because the listing copy artifact embeds it, `claims.validator_details`
// stores each segment's part of it, and verification (P3-06), Gate 2 (P3-08), and the web app
// read it. Findings quote the offending number token and fact IDs, never whole segments; they
// still describe the property, so they share the copy's personal-data scope and stay out of
// events and logs.

/** Bumped when a rule changes what passes, so stored reports can be told apart. */
export const CLAIM_VALIDATOR_RULES_VERSION = 1;

/**
 * Stable finding codes. Every finding rejects its segment: it is not publishable as written.
 *
 * - `missing_fact_ids`: the segment cites nothing.
 * - `unknown_fact_id`: a cited ID is not a fact of this run.
 * - `unverified_fact`: a cited fact exists but is not `verified`.
 * - `opinion_cited`: a cited fact is an opinion, never a valid source.
 * - `number_not_in_facts`: a number equals no cited fact's value.
 * - `unit_mismatch`: the value matches, but the unit next to it is not the fact's unit.
 * - `number_from_photo`: an unmatched number in a segment that cites photo facts, which are
 *   presence evidence only (their stored value is a per-photo count, not a property total).
 * - `approximate_number`: approximate wording around a number ("about 95", "ca. 92", "95+").
 * - `number_range`: two numbers given as a range ("90-95", "tussen 90 en 95").
 * - `unreadable_number`: a number that cannot be read as one exact value in the segment's
 *   language (separators of the other language, "165k", "1980s", "2 million").
 */
export const CLAIM_FINDING_CODES = [
  'missing_fact_ids',
  'unknown_fact_id',
  'unverified_fact',
  'opinion_cited',
  'number_not_in_facts',
  'unit_mismatch',
  'number_from_photo',
  'approximate_number',
  'number_range',
  'unreadable_number',
] as const;
export const claimFindingCodeSchema = z.enum(CLAIM_FINDING_CODES);
export type ClaimFindingCode = z.infer<typeof claimFindingCodeSchema>;

const count = z.int().nonnegative();

/** One problem in one segment, addressed by the caller's variant name and segment index. */
export const claimFindingSchema = z.strictObject({
  /** The caller's grouping: `portal` or `social` for listing copy, e.g. `qa` for Q&A cards. */
  variant: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  /** The caller's segment index (for listing copy: `segment.index` = `claims.segment_index`). */
  segmentIndex: count,
  code: claimFindingCodeSchema,
  /** The offending span (a number with its unit or marker), capped; null for citation codes. */
  token: z.string().min(1).max(60).nullable(),
  /** The cited fact ID the finding is about (citation codes and unit mismatches), else null. */
  factId: z.string().min(1).max(64).nullable(),
  /** One operator-readable English sentence built from the code, token, and fact unit. */
  detail: z.string().min(1).max(300),
});
export type ClaimFinding = z.infer<typeof claimFindingSchema>;

export const claimValidationReportSchema = z
  .strictObject({
    rulesVersion: z.literal(CLAIM_VALIDATOR_RULES_VERSION),
    /** The language numbers and number words were read in (ISO 639-1). */
    language: z.string().regex(/^[a-z]{2}$/),
    /** `pass` exactly when there are no findings. */
    result: validatorResultSchema,
    counts: z.strictObject({
      segments: count,
      failedSegments: count,
      /** Number claims read in the text (digits, number words, ordinals, dates and times). */
      numbers: count,
      findings: count,
    }),
    /** In segment order, then text order. */
    findings: z.array(claimFindingSchema),
  })
  .superRefine((report, ctx) => {
    if ((report.result === 'pass') !== (report.findings.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['result'], message: 'pass means no findings' });
    }
    if (report.counts.findings !== report.findings.length) {
      ctx.addIssue({ code: 'custom', path: ['counts', 'findings'], message: 'Finding count' });
    }
    const failed = new Set(report.findings.map((f) => `${f.variant}\u0000${f.segmentIndex}`));
    if (report.counts.failedSegments !== failed.size) {
      ctx.addIssue({
        code: 'custom',
        path: ['counts', 'failedSegments'],
        message: 'Failed segment count',
      });
    }
    if (report.counts.failedSegments > report.counts.segments) {
      ctx.addIssue({ code: 'custom', path: ['counts'], message: 'More failed than segments' });
    }
  });
export type ClaimValidationReport = z.infer<typeof claimValidationReportSchema>;

/** `claims.validator_details` for one segment: its findings (empty when it passed). */
export const claimValidatorDetailsSchema = z.strictObject({
  rulesVersion: z.literal(CLAIM_VALIDATOR_RULES_VERSION),
  findings: z.array(claimFindingSchema),
});
export type ClaimValidatorDetails = z.infer<typeof claimValidatorDetailsSchema>;
