import { z } from 'zod';
import { stepAgentSchema } from './definitions.ts';
import {
  gateSchema,
  runStatusSchema,
  runStepStatusSchema,
  usdAmountSchema,
  type RunStatus,
} from './domain.ts';
import { exportManifestContentSchema } from './export.ts';
import {
  claimsAuditedPayloadSchema,
  copyGeneratedPayloadSchema,
  factsExtractedPayloadSchema,
  factsReconciledPayloadSchema,
  gateDecidedPayloadSchema,
  gateOpenedPayloadSchema,
  imagesStagedPayloadSchema,
  integrityCheckedPayloadSchema,
  packExportedPayloadSchema,
  photosInventoriedPayloadSchema,
  qaCardsGeneratedPayloadSchema,
  stepCompletedPayloadSchema,
  stepFailedPayloadSchema,
  stepStartedPayloadSchema,
  transcriptStoredPayloadSchema,
  usageRecordedPayloadSchema,
} from './run-events.ts';

// Run, evidence, and export API contracts (docs/architecture.md §5 "Run API"): the run monitor's
// snapshot and event stream (P4-05), the owner-only evidence files the gates link to (P4-06,
// P4-07), and the stored export (P4-08). Snapshots and events carry IDs, counts, costs, and
// operator-safe reasons only; the files are customer material (personal-data scope).

const isoDateTime = z.iso.datetime({ offset: true });
const count = z.int().nonnegative();

// --- Path and query parameters ----------------------------------------------------------------

export const runParamsSchema = z.strictObject({ runId: z.uuid() });
export const projectRunsParamsSchema = z.strictObject({ projectId: z.uuid() });
export const runMaterialParamsSchema = z.strictObject({ runId: z.uuid(), materialId: z.uuid() });
export const runArtifactParamsSchema = z.strictObject({ runId: z.uuid(), artifactId: z.uuid() });
export const runFactParamsSchema = z.strictObject({ runId: z.uuid(), factId: z.uuid() });

/** `?download=1` asks for `Content-Disposition: attachment`; anything else is inline. */
export const fileDownloadQuerySchema = z.object({ download: z.literal('1').optional() });

/**
 * Where the event stream resumes: the `Last-Event-ID` header (sent by `EventSource` on a
 * reconnect) wins over `?after=` (the snapshot's `lastEventSeq`, for the first connect); without
 * either the stream starts at the run's first event.
 */
export const runEventCursorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,9})$/, 'Expected an event sequence number')
  .transform(Number)
  .pipe(z.int().nonnegative().max(2_147_483_647));
export const runEventsQuerySchema = z.object({ after: runEventCursorSchema.optional() });

// --- URLs -------------------------------------------------------------------------------------
// The one place the URL scheme is spelled out: the API builds the export's links with these, and
// the web app builds evidence links from the IDs the gate responses return.

/** A path segment: IDs are UUIDs, but a builder must never let input change the path. */
function pathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function withDownload(url: string, download: boolean | undefined): string {
  return download === true ? `${url}?download=1` : url;
}

/** `GET` the run snapshot (`runSnapshotSchema`). */
export function runUrl(runId: string): string {
  return `/api/runs/${pathSegment(runId)}`;
}

/** The SSE stream; `after` is the snapshot's `lastEventSeq` (omit to replay from the start). */
export function runEventsUrl(runId: string, after?: number): string {
  if (after === undefined) return `/api/runs/${pathSegment(runId)}/events`;
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new RangeError('`after` must be a non-negative integer event sequence');
  }
  return `/api/runs/${pathSegment(runId)}/events?after=${after}`;
}

/** An original photo or the voice memo (`materials.id`), Range-capable. */
export function runMaterialFileUrl(
  runId: string,
  materialId: string,
  options: { download?: boolean } = {},
): string {
  return withDownload(
    `/api/runs/${pathSegment(runId)}/materials/${pathSegment(materialId)}/file`,
    options.download,
  );
}

/** An image artifact's file (`artifacts.id`): a staged image or an exported JPEG. */
export function runArtifactFileUrl(
  runId: string,
  artifactId: string,
  options: { download?: boolean } = {},
): string {
  return withDownload(
    `/api/runs/${pathSegment(runId)}/artifacts/${pathSegment(artifactId)}/file`,
    options.download,
  );
}

/**
 * The voice memo a transcript was made from (`factSource.transcriptArtifactId`), Range-capable:
 * play a turn by seeking to `startMs / 1000`.
 */
export function runTranscriptAudioUrl(runId: string, transcriptArtifactId: string): string {
  return `/api/runs/${pathSegment(runId)}/transcripts/${pathSegment(transcriptArtifactId)}/audio`;
}

/**
 * The mask overlay of a `photo_region` fact (only when its source has a `maskArtifactId`): a
 * transparent PNG the size of the stored photo (see `RUN_FACT_MASK_PNG`).
 */
export function runFactMaskUrl(runId: string, factId: string): string {
  return `/api/runs/${pathSegment(runId)}/facts/${pathSegment(factId)}/mask.png`;
}

/** `GET` the export manifest (`runExportResponseSchema`). */
export function runExportUrl(runId: string): string {
  return `/api/runs/${pathSegment(runId)}/export`;
}

/** One file of the export manifest; the HTML pack is viewable inline, the JSON always downloads. */
export function runExportFileUrl(
  runId: string,
  artifactId: string,
  options: { download?: boolean } = {},
): string {
  return withDownload(
    `/api/runs/${pathSegment(runId)}/export/files/${pathSegment(artifactId)}`,
    options.download,
  );
}

/**
 * A project's stored material (photo JPEG or voice memo WAV) before or without a run: the
 * capture screen's thumbnails and memo playback. Owner-only, Range-capable.
 */
export function projectMaterialFileUrl(
  projectId: string,
  materialId: string,
  options: { download?: boolean } = {},
): string {
  return withDownload(
    `/api/projects/${pathSegment(projectId)}/materials/${pathSegment(materialId)}/file`,
    options.download,
  );
}

/** `GET` a project's runs, newest first (`projectRunsResponseSchema`). */
export function projectRunsUrl(projectId: string): string {
  return `/api/projects/${pathSegment(projectId)}/runs`;
}

/**
 * The mask overlay format: an RGBA PNG exactly the stored photo's width and height (the frame
 * the photo file and SAM's boxes share). Mask pixels are opaque white, every other pixel fully
 * transparent; it is the union of the masks of every region of the fact's observation. Use it as
 * a CSS `mask-image` over a coloured layer laid exactly over the photo.
 */
export const RUN_FACT_MASK_PNG = {
  mimeType: 'image/png',
  maskRgba: [255, 255, 255, 255],
  backgroundRgba: [0, 0, 0, 0],
} as const;

// --- Run snapshot -----------------------------------------------------------------------------

/**
 * A step as the monitor shows it: `pending` until its first attempt is scheduled, then the
 * latest attempt's status (`queued` also while a failed execution waits for its retry; `error`
 * then says why).
 */
export const RUN_STEP_VIEW_STATUSES = ['pending', ...runStepStatusSchema.options] as const;
export const runStepViewStatusSchema = z.enum(RUN_STEP_VIEW_STATUSES);
export type RunStepViewStatus = z.infer<typeof runStepViewStatusSchema>;

export const runStepSnapshotSchema = z.strictObject({
  stepId: z.string().min(1),
  /** From the service definition; null for a step the run's definition version no longer has. */
  agent: stepAgentSchema.nullable(),
  /** The gate the run pauses at after this step completes. */
  gateAfter: gateSchema.nullable(),
  status: runStepViewStatusSchema,
  /** The latest attempt (a resume after failure starts a new one); null while pending. */
  attempt: z.int().positive().nullable(),
  /** Attempts scheduled so far. */
  attempts: count,
  /** Handler executions of the latest attempt (at most `maxExecutionsPerAttempt`). */
  executions: count,
  /** Handler executions across all attempts. */
  totalExecutions: count,
  /** Every ledger row of this step in this run, across attempts and executions. */
  costUsd: usdAmountSchema,
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  /** Set once the run was released past this step's `gateAfter`. */
  gateReleasedAt: isoDateTime.nullable(),
  /** Operator-safe reason of the latest attempt's last failure; null when it has none. */
  error: z.string().min(1).nullable(),
});
export type RunStepSnapshot = z.infer<typeof runStepSnapshotSchema>;

/** The stored export at a glance; the files are in `GET /api/runs/:runId/export`. */
export const runExportSummarySchema = z.strictObject({
  manifestArtifactId: z.uuid(),
  readyToPublish: z.boolean(),
  fileCount: z.int().positive(),
});
export type RunExportSummary = z.infer<typeof runExportSummarySchema>;

const runCommon = {
  id: z.uuid(),
  projectId: z.uuid(),
  status: runStatusSchema,
  serviceId: z.string().min(1),
  serviceVersion: z.int().positive(),
  marketProfileId: z.string().min(1),
  marketProfileVersion: z.int().positive(),
  outputLanguage: z.string().min(1),
  /** The gate the run waits at; set exactly when `status` is `awaiting_gate`. */
  gate: gateSchema.nullable(),
  currentStepId: z.string().min(1).nullable(),
  /** Operator-safe failure reason; set exactly when `status` is `failed`. */
  failureReason: z.string().min(1).nullable(),
  createdAt: isoDateTime,
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  /** Every ledger row of the run (exact decimal string). */
  costUsd: usdAmountSchema,
};

/** `GET /api/runs/:runId`: one consistent read (one database snapshot). */
export const runSnapshotSchema = z.strictObject({
  ...runCommon,
  updatedAt: isoDateTime,
  /** The run's newest event; open the stream with `?after=<lastEventSeq>` to continue from here. */
  lastEventSeq: count,
  /** `budget.max_cost_usd_per_run` of the run's definition; null if that version is gone. */
  costCapUsd: usdAmountSchema.nullable(),
  maxExecutionsPerAttempt: z.int().positive(),
  /** The definition's steps in order, then any stored step it no longer lists. */
  steps: z.array(runStepSnapshotSchema),
  /** Null until the export step has stored its manifest. */
  export: runExportSummarySchema.nullable(),
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

export const runSummarySchema = z.strictObject(runCommon);
export type RunSummary = z.infer<typeof runSummarySchema>;

/** `GET /api/projects/:projectId/runs`: newest first. */
export const projectRunsResponseSchema = z.strictObject({ runs: z.array(runSummarySchema) });
export type ProjectRunsResponse = z.infer<typeof projectRunsResponseSchema>;

// --- Event stream -----------------------------------------------------------------------------

/** Appended by `transitionRun` with every status change. */
export const runStatusChangedPayloadSchema = z.strictObject({
  from: runStatusSchema,
  to: runStatusSchema,
  /** Present when `to` is `awaiting_gate`. */
  gate: gateSchema.optional(),
  /** Present when `to` is `failed`: operator-safe text. */
  reason: z.string().min(1).optional(),
});
export type RunStatusChangedPayload = z.infer<typeof runStatusChangedPayloadSchema>;

const streamEvent = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({
    /** The event's `seq`, also the SSE `id`. Gapless and increasing per run. */
    seq: z.int().positive(),
    type: z.literal(type),
    payload,
    occurredAt: isoDateTime,
  });

/**
 * The `data` of each default (`message`) SSE event: one stored `run_events` row. Parse with
 * `safeParse`: an event type added later fails here, and the client should then refetch the
 * snapshot instead of stopping.
 */
export const runStreamEventSchema = z.discriminatedUnion('type', [
  streamEvent('run_status_changed', runStatusChangedPayloadSchema),
  streamEvent('step_started', stepStartedPayloadSchema),
  streamEvent('step_completed', stepCompletedPayloadSchema),
  streamEvent('step_failed', stepFailedPayloadSchema),
  streamEvent('gate_opened', gateOpenedPayloadSchema),
  streamEvent('gate_decided', gateDecidedPayloadSchema),
  streamEvent('usage_recorded', usageRecordedPayloadSchema),
  streamEvent('transcript_stored', transcriptStoredPayloadSchema),
  streamEvent('facts_extracted', factsExtractedPayloadSchema),
  streamEvent('photos_inventoried', photosInventoriedPayloadSchema),
  streamEvent('facts_reconciled', factsReconciledPayloadSchema),
  streamEvent('copy_generated', copyGeneratedPayloadSchema),
  streamEvent('qa_cards_generated', qaCardsGeneratedPayloadSchema),
  streamEvent('images_staged', imagesStagedPayloadSchema),
  streamEvent('integrity_checked', integrityCheckedPayloadSchema),
  streamEvent('claims_audited', claimsAuditedPayloadSchema),
  streamEvent('pack_exported', packExportedPayloadSchema),
]);
export type RunStreamEvent = z.infer<typeof runStreamEventSchema>;

/** Run states after which the stream sends `end` and closes (a failed run may be resumed). */
export const RUN_STREAM_TERMINAL_STATUSES = [
  'completed',
  'failed',
] as const satisfies readonly RunStatus[];

export function isRunStreamTerminal(status: RunStatus): boolean {
  return RUN_STREAM_TERMINAL_STATUSES.some((terminal) => terminal === status);
}

/** The SSE event name of the last message; the client must call `EventSource.close()` on it. */
export const RUN_STREAM_END_EVENT = 'end';

/**
 * The SSE event name sent when the requested cursor is beyond the run's newest event (a stale or
 * foreign `Last-Event-ID`, a hand-made `after`): the stream continues from the run's real head,
 * and the client should refetch the snapshot, whose state it can no longer trust.
 */
export const RUN_STREAM_RESYNC_EVENT = 'resync';

export const runStreamResyncSchema = z.strictObject({ lastEventSeq: count });
export type RunStreamResync = z.infer<typeof runStreamResyncSchema>;

/** `data` of the `end` event: the run reached a terminal state and every event was sent. */
export const runStreamEndSchema = z.strictObject({
  status: z.enum(RUN_STREAM_TERMINAL_STATUSES),
  lastEventSeq: count,
});
export type RunStreamEnd = z.infer<typeof runStreamEndSchema>;

// --- Export -----------------------------------------------------------------------------------

const manifestFileSchema = exportManifestContentSchema.shape.files.element;

/**
 * The export response with its file links under `urlPrefix`: the owner's API (`/api/runs/`) and
 * the public demo API (`/api/demo/runs/`, `demoRunExportResponseSchema`) share the shape.
 */
export function runExportResponseSchemaFor(urlPrefix: string) {
  const file = z.strictObject({
    ...manifestFileSchema.shape,
    /** Inline (the HTML renders, images display); the JSON is always an attachment. */
    url: z.string().startsWith(urlPrefix),
    /** `Content-Disposition: attachment` with `fileName`. */
    downloadUrl: z.string().startsWith(urlPrefix),
  });
  return z.strictObject({
    runId: z.uuid(),
    manifestArtifactId: z.uuid(),
    approvedPackArtifactId: z.uuid(),
    readyToPublish: z.boolean(),
    counts: exportManifestContentSchema.shape.counts,
    files: z.array(file).min(2),
  });
}

/** `GET /api/runs/:runId/export`: the stored manifest, files in order (HTML, JSON, images). */
export const runExportResponseSchema = runExportResponseSchemaFor('/api/runs/');
export type RunExportResponse = z.infer<typeof runExportResponseSchema>;

export const runExportFileSchema = runExportResponseSchema.shape.files.element;
export type RunExportFile = z.infer<typeof runExportFileSchema>;
