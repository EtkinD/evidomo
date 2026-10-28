import { z } from 'zod';

// Upload limits and the processing metadata stored in `materials.metadata`
// (docs/architecture.md section 8). Shared so the web app can pre-check files and show the
// same reasons the server returns.

const MIB = 1024 * 1024;

export const UPLOAD_LIMITS = {
  /** Phone photos are 2-15 MB; the web app downscales before upload (P4-03). */
  photoMaxBytes: 25 * MIB,
  /**
   * Decompression-bomb guard: decoded pixel count (width x height) per photo. Covers 108 MP
   * phone cameras; larger files must be downscaled first.
   */
  photoMaxPixels: 100_000_000,
  /** Long edge of the stored photo; smaller photos are never enlarged. */
  photoLongEdgePx: 2048,
  /** Enough for 10 minutes of uncompressed 48 kHz stereo WAV; compressed memos are far smaller. */
  voiceMemoMaxBytes: 128 * MIB,
  /** Product limit (docs/product.md) and the Voice Transcribe file limit (P1-04). */
  voiceMemoMaxDurationMs: 600_000,
} as const;

export type UploadLimits = { readonly [K in keyof typeof UPLOAD_LIMITS]: number };

/** Why an upload was refused. Codes are safe to show to the uploader. */
export const UPLOAD_REJECTION_CODES = [
  'empty_file',
  'file_too_large',
  'unsupported_format',
  'heic_not_supported',
  'too_many_pixels',
  'undecodable',
  'too_long',
] as const;
export const uploadRejectionCodeSchema = z.enum(UPLOAD_REJECTION_CODES);
export type UploadRejectionCode = z.infer<typeof uploadRejectionCodeSchema>;

/** Stored on a material whose processing failed after its row was written. */
export const MATERIAL_FAILURE_REASONS = [...UPLOAD_REJECTION_CODES, 'internal_error'] as const;
export const materialFailureReasonSchema = z.enum(MATERIAL_FAILURE_REASONS);
export type MaterialFailureReason = z.infer<typeof materialFailureReasonSchema>;

export const PHOTO_SOURCE_FORMATS = ['jpeg', 'png', 'webp'] as const;
export type PhotoSourceFormat = (typeof PHOTO_SOURCE_FORMATS)[number];

const dimension = z.number().int().positive();

/** `ready` photo: the stored JPEG's dimensions and what the upload was. */
export const photoMaterialMetadataSchema = z.strictObject({
  width: dimension,
  height: dimension,
  sourceFormat: z.enum(PHOTO_SOURCE_FORMATS),
  /** Upload dimensions after EXIF orientation was applied. */
  sourceWidth: dimension,
  sourceHeight: dimension,
});
export type PhotoMaterialMetadata = z.infer<typeof photoMaterialMetadataSchema>;

/** `ready` voice memo: the stored transcription WAV and what the upload was. */
export const voiceMemoMaterialMetadataSchema = z.strictObject({
  /** From the stored WAV's sample data, not from the upload's container header. */
  durationMs: z.number().int().positive(),
  sampleRate: z.union([z.literal(16_000), z.literal(24_000)]),
  /** ffprobe demuxer name, e.g. `matroska,webm`. */
  sourceContainer: z.string().min(1),
  /** ffprobe codec name, e.g. `opus`. */
  sourceCodec: z.string().min(1),
});
export type VoiceMemoMaterialMetadata = z.infer<typeof voiceMemoMaterialMetadataSchema>;

export const failedMaterialMetadataSchema = z.strictObject({
  failureReason: materialFailureReasonSchema,
});
export type FailedMaterialMetadata = z.infer<typeof failedMaterialMetadataSchema>;
