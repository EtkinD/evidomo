import { describe, expect, it } from 'vitest';
import {
  failedMaterialMetadataSchema,
  MATERIAL_FAILURE_REASONS,
  photoMaterialMetadataSchema,
  UPLOAD_LIMITS,
  UPLOAD_REJECTION_CODES,
  voiceMemoMaterialMetadataSchema,
} from './materials.ts';

describe('material metadata schemas', () => {
  it('accepts the processing output for each kind', () => {
    expect(
      photoMaterialMetadataSchema.parse({
        width: 2048,
        height: 1536,
        sourceFormat: 'jpeg',
        sourceWidth: 4032,
        sourceHeight: 3024,
      }).width,
    ).toBe(2048);
    expect(
      voiceMemoMaterialMetadataSchema.parse({
        durationMs: 168_730,
        sampleRate: 16_000,
        sourceContainer: 'matroska,webm',
        sourceCodec: 'opus',
      }).durationMs,
    ).toBe(168_730);
  });

  it('rejects unknown keys, so nothing unexpected (e.g. EXIF fields) is persisted', () => {
    expect(
      photoMaterialMetadataSchema.safeParse({
        width: 1,
        height: 1,
        sourceFormat: 'png',
        sourceWidth: 1,
        sourceHeight: 1,
        gps: '52.37,4.89',
      }).success,
    ).toBe(false);
    expect(
      voiceMemoMaterialMetadataSchema.safeParse({
        durationMs: 1,
        sampleRate: 44_100,
        sourceContainer: 'wav',
        sourceCodec: 'pcm_s16le',
      }).success,
    ).toBe(false);
  });

  it('limits failure reasons to rejection codes plus internal_error', () => {
    expect(MATERIAL_FAILURE_REASONS).toEqual([...UPLOAD_REJECTION_CODES, 'internal_error']);
    expect(failedMaterialMetadataSchema.parse({ failureReason: 'too_long' })).toEqual({
      failureReason: 'too_long',
    });
    expect(
      failedMaterialMetadataSchema.safeParse({ failureReason: 'ffmpeg exploded' }).success,
    ).toBe(false);
  });

  it('caps voice memos at the 10-minute product limit', () => {
    expect(UPLOAD_LIMITS.voiceMemoMaxDurationMs).toBe(600_000);
  });
});
