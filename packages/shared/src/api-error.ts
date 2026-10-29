import { z } from 'zod';
import { claimFindingSchema } from './claims.ts';

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
  // Gate 2: approval refused while a flagged claim or an offered staged image is undecided.
  'gate_decisions_pending',
  // Gate 2: an edited claim fails the claim validator; `findings` says why.
  'claim_edit_rejected',
  // Run API: the run has no stored export yet (the export step has not completed).
  'export_not_ready',
  // A `Range` request that starts at or beyond the end of the file (416, `Content-Range: */size`).
  'range_not_satisfiable',
  // Run API: the user already has the maximum number of open event streams.
  'too_many_streams',
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
  // Present on `claim_edit_rejected` only: the validator's findings on the operator's own text.
  findings: z.array(claimFindingSchema).optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
