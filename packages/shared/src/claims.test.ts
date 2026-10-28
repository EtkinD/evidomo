import { describe, expect, it } from 'vitest';
import {
  CLAIM_FINDING_CODES,
  claimValidationReportSchema,
  claimValidatorDetailsSchema,
  type ClaimFinding,
  type ClaimValidationReport,
} from './claims.ts';

const finding: ClaimFinding = {
  variant: 'portal',
  segmentIndex: 3,
  code: 'number_not_in_facts',
  token: 'ca. 95 m²',
  factId: null,
  detail: '"ca. 95 m²" is not stated by any cited fact.',
};
const report: ClaimValidationReport = {
  rulesVersion: 1,
  language: 'nl',
  result: 'fail',
  counts: { segments: 5, failedSegments: 1, numbers: 4, findings: 2 },
  findings: [finding, { ...finding, code: 'approximate_number' }],
};

describe('claim validation report', () => {
  it('accepts a consistent report', () => {
    expect(claimValidationReportSchema.parse(report)).toEqual(report);
    expect(
      claimValidationReportSchema.parse({
        ...report,
        result: 'pass',
        counts: { segments: 5, failedSegments: 0, numbers: 4, findings: 0 },
        findings: [],
      }).result,
    ).toBe('pass');
  });

  it('keeps result, counts, and findings consistent', () => {
    const parse = (value: unknown) => claimValidationReportSchema.safeParse(value).success;
    expect(parse({ ...report, result: 'pass' })).toBe(false);
    expect(parse({ ...report, counts: { ...report.counts, findings: 1 } })).toBe(false);
    expect(parse({ ...report, counts: { ...report.counts, failedSegments: 2 } })).toBe(false);
    expect(parse({ ...report, counts: { ...report.counts, segments: 0 } })).toBe(false);
    expect(parse({ ...report, rulesVersion: 2 })).toBe(false);
  });

  it('bounds what a finding may carry: a short token, never a paragraph', () => {
    const parse = (value: Record<string, unknown>) =>
      claimValidationReportSchema.safeParse({
        ...report,
        findings: [{ ...finding, ...value }, finding],
      }).success;
    expect(parse({ token: 'x'.repeat(61) })).toBe(false);
    expect(parse({ detail: 'x'.repeat(301) })).toBe(false);
    expect(parse({ variant: 'Portal copy' })).toBe(false);
    expect(parse({ code: 'other' })).toBe(false);
    expect(parse({ text: 'A home' })).toBe(false);
  });

  it('has a stable code list', () => {
    expect(CLAIM_FINDING_CODES).toEqual([
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
    ]);
  });

  it('stores one segment’s findings as claims.validator_details', () => {
    expect(claimValidatorDetailsSchema.parse({ rulesVersion: 1, findings: [finding] })).toEqual({
      rulesVersion: 1,
      findings: [finding],
    });
  });
});
