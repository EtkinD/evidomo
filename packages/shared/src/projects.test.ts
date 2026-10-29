import { describe, expect, it } from 'vitest';
import { apiErrorSchema } from './api-error.ts';
import {
  createProjectRequestSchema,
  definitionParamsSchema,
  putFactFormRequestSchema,
  startRunRequestSchema,
  updateProjectRequestSchema,
} from './projects.ts';

describe('project API contracts', () => {
  it('parses definition path parameters strictly', () => {
    expect(definitionParamsSchema.parse({ id: 'nl', version: '1' })).toEqual({
      id: 'nl',
      version: 1,
    });
    for (const version of ['0', '01', '1.0', '-1', 'x']) {
      expect(definitionParamsSchema.safeParse({ id: 'nl', version }).success).toBe(false);
    }
  });

  it('requires title, office profile, market, and language; trims the title', () => {
    const body = {
      title: '  Apartment  ',
      officeProfile: { agencyName: 'Office' },
      market: { id: 'nl', version: 1 },
      outputLanguage: 'en',
    };
    expect(createProjectRequestSchema.parse(body).title).toBe('Apartment');
    expect(
      createProjectRequestSchema.safeParse({ ...body, outputLanguage: undefined }).success,
    ).toBe(false);
    expect(
      createProjectRequestSchema.safeParse({
        ...body,
        officeProfile: { agencyName: 'Office', logo: 'x' },
      }).success,
    ).toBe(false);
  });

  it('needs at least one field to update', () => {
    expect(updateProjectRequestSchema.safeParse({}).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ title: 'New' }).success).toBe(true);
  });

  it('accepts scalar or null fact form values and bounds the field count', () => {
    expect(
      putFactFormRequestSchema.parse({ values: { energy_label: 'B', ground_lease: null } }),
    ).toEqual({ values: { energy_label: 'B', ground_lease: null } });
    expect(putFactFormRequestSchema.safeParse({ values: { a: [1] } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}`, 1]));
    expect(putFactFormRequestSchema.safeParse({ values: many }).success).toBe(false);
  });

  it('takes an empty run start body for now', () => {
    expect(startRunRequestSchema.safeParse({}).success).toBe(true);
    expect(startRunRequestSchema.safeParse({ accessCode: 'x' }).success).toBe(false);
  });

  it('carries the typed details of project errors', () => {
    expect(
      apiErrorSchema.parse({
        error: 'not_ready',
        missing: [{ kind: 'photos', count: 3, min: 10, max: 30 }, { kind: 'voice_memo' }],
      }).missing,
    ).toHaveLength(2);
    expect(
      apiErrorSchema.parse({ error: 'upload_rejected', reason: 'heic_not_supported' }).reason,
    ).toBe('heic_not_supported');
    expect(
      apiErrorSchema.parse({ error: 'validation_failed', fields: { build_year: 'out_of_range' } })
        .fields,
    ).toEqual({ build_year: 'out_of_range' });
  });
});
