import { describe, expect, it } from 'vitest';
import { factSourceSchema, officeProfileSchema, usdAmountSchema } from './domain.ts';

const uuid = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';

describe('factSourceSchema', () => {
  it('accepts each provenance kind', () => {
    expect(factSourceSchema.parse({ kind: 'form', field: 'living_area' }).kind).toBe('form');
    expect(
      factSourceSchema.parse({
        kind: 'transcript_turn',
        transcriptArtifactId: uuid,
        turnIndex: 0,
        startMs: 0,
        endMs: 1200,
        quote: 'twee slaapkamers',
      }).kind,
    ).toBe('transcript_turn');
    expect(
      factSourceSchema.parse({
        kind: 'photo_region',
        materialId: uuid,
        region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
      }).kind,
    ).toBe('photo_region');
  });

  it('rejects inverted turn timestamps and regions outside the image', () => {
    expect(
      factSourceSchema.safeParse({
        kind: 'transcript_turn',
        transcriptArtifactId: uuid,
        turnIndex: 0,
        startMs: 2000,
        endMs: 1000,
        quote: 'twee slaapkamers',
      }).success,
    ).toBe(false);
    // No quote, no claim: a transcript fact must carry the span it was extracted from.
    for (const quote of [undefined, '']) {
      expect(
        factSourceSchema.safeParse({
          kind: 'transcript_turn',
          transcriptArtifactId: uuid,
          turnIndex: 0,
          startMs: 0,
          endMs: 1000,
          quote,
        }).success,
      ).toBe(false);
    }
    expect(
      factSourceSchema.safeParse({
        kind: 'photo_region',
        materialId: uuid,
        region: { x: 0.8, y: 0, width: 0.3, height: 0.1 },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown provenance kinds', () => {
    expect(factSourceSchema.safeParse({ kind: 'guess', field: 'x' }).success).toBe(false);
  });
});

describe('usdAmountSchema', () => {
  it('accepts exact decimals up to 8 fraction digits', () => {
    expect(usdAmountSchema.parse('0.00000125')).toBe('0.00000125');
    expect(usdAmountSchema.parse('12')).toBe('12');
  });

  it('rejects negatives, exponent notation, and excess precision', () => {
    for (const value of ['-1', '1e-6', '0.000000001', '', '10000']) {
      expect(usdAmountSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('officeProfileSchema', () => {
  it('requires a non-blank agency name', () => {
    expect(officeProfileSchema.safeParse({ agencyName: '  ' }).success).toBe(false);
    expect(officeProfileSchema.parse({ agencyName: ' Example ' }).agencyName).toBe('Example');
  });
});
