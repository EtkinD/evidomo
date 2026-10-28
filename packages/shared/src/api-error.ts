import { z } from 'zod';

/**
 * Machine-readable error codes returned by the API as `{ error: <code> }`. Clients branch on
 * the code, never on the HTTP status text or a message.
 */
export const apiErrorCodeSchema = z.enum([
  'validation_failed',
  'invalid_json',
  'payload_too_large',
  'unsupported_media_type',
  'forbidden_origin',
  'unauthenticated',
  'invalid_credentials',
  'email_taken',
  'rate_limited',
  // Missing, or owned by another user: the API never confirms that someone else's ID exists.
  'not_found',
  // The run is not paused at the gate the request decides (not reached yet, released, or failed).
  'gate_not_open',
  'fact_not_in_conflict',
  'internal_error',
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiValidationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

export type ApiValidationIssue = z.infer<typeof apiValidationIssueSchema>;

export const apiErrorSchema = z.object({
  error: apiErrorCodeSchema,
  // Present on `validation_failed` only; never echoes the submitted values.
  issues: z.array(apiValidationIssueSchema).optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
