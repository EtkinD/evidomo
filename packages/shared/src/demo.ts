import { z } from 'zod';
import { claimAuditGateResponseSchema } from './gate2.ts';
import { runEventCursorSchema, runExportResponseSchemaFor } from './run-api.ts';

// Public demo API contracts (docs/architecture.md §5 "Demo API", §11): read-only, no session,
// for the completed runs the server lists in `DEMO_RUN_IDS`. Every response reuses the owner
// API's shape (snapshot, events, gates, evidence files, export) so the web app renders a demo
// run with the same components; the only differences are the URL prefix, the export links, and
// that nothing identifies a user (Gate 2's sign-off carries no `decidedBy`).

const isoDateTime = z.iso.datetime({ offset: true });

/** Every demo route lives under this prefix. */
export const DEMO_RUNS_PATH = '/api/demo/runs';

// --- Query parameters -------------------------------------------------------------------------

/** Replay speed multiplier bounds for `GET /api/demo/runs/:runId/events?speed=`. */
export const DEMO_REPLAY_SPEED = { min: 0.25, max: 10, default: 1 } as const;

/** `?speed=`: a plain decimal with at most two fraction digits, within `DEMO_REPLAY_SPEED`. */
export const demoReplaySpeedSchema = z
  .string()
  .regex(/^[0-9]{1,2}(\.[0-9]{1,2})?$/, 'Expected a number such as 2 or 0.5')
  .transform(Number)
  .pipe(z.number().min(DEMO_REPLAY_SPEED.min).max(DEMO_REPLAY_SPEED.max));

/**
 * The replay stream's query: `after` (first connect; `Last-Event-ID` wins on a reconnect, as on
 * the live stream) and `speed` (default 1, the original timing with long gaps compressed).
 */
export const demoRunEventsQuerySchema = z.object({
  after: runEventCursorSchema.optional(),
  speed: demoReplaySpeedSchema.optional(),
});

// --- Responses --------------------------------------------------------------------------------

/** A public demo run as the demo landing page lists it. */
export const demoRunSchema = z.strictObject({
  id: z.uuid(),
  /** The (synthetic) project's title. */
  title: z.string().min(1),
  marketProfileId: z.string().min(1),
  outputLanguage: z.string().min(1),
  createdAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
});
export type DemoRun = z.infer<typeof demoRunSchema>;

/** `GET /api/demo/runs`: the configured demo runs that exist and completed, in `DEMO_RUN_IDS` order. */
export const demoRunListResponseSchema = z.strictObject({ runs: z.array(demoRunSchema) });
export type DemoRunListResponse = z.infer<typeof demoRunListResponseSchema>;

/**
 * `GET /api/demo/runs/:runId/gates/claim-audit`: Gate 2 as it was decided, without the user ID of
 * whoever signed it off. Every other field is `claimAuditGateResponseSchema`'s.
 */
export const demoClaimAuditGateResponseSchema = claimAuditGateResponseSchema.extend({
  approval: z.strictObject({ decidedAt: isoDateTime }).nullable(),
});
export type DemoClaimAuditGateResponse = z.infer<typeof demoClaimAuditGateResponseSchema>;

/** `GET /api/demo/runs/:runId/export`: the owner API's export with demo file links. */
export const demoRunExportResponseSchema = runExportResponseSchemaFor(`${DEMO_RUNS_PATH}/`);
export type DemoRunExportResponse = z.infer<typeof demoRunExportResponseSchema>;

// --- URLs -------------------------------------------------------------------------------------
// The demo mirror of the `run-api.ts` builders (same segments, `/api/demo/runs` instead of
// `/api/runs`). Path segments are `encodeURIComponent`-encoded.

function demoRunPath(runId: string, ...rest: string[]): string {
  return [DEMO_RUNS_PATH, runId, ...rest]
    .map((part, index) => (index === 0 ? part : encodeURIComponent(part)))
    .join('/');
}

function withDownload(url: string, download: boolean | undefined): string {
  return download === true ? `${url}?download=1` : url;
}

/** `GET` the demo run list (`demoRunListResponseSchema`). */
export function demoRunsUrl(): string {
  return DEMO_RUNS_PATH;
}

/** `GET` a demo run's snapshot (`runSnapshotSchema`). */
export function demoRunUrl(runId: string): string {
  return demoRunPath(runId);
}

/**
 * The replay stream. `after` is the seq to continue from (omit to replay from the first event);
 * `speed` a multiplier within `DEMO_REPLAY_SPEED` with at most two fraction digits.
 */
export function demoRunEventsUrl(
  runId: string,
  options: { after?: number; speed?: number } = {},
): string {
  const query = new URLSearchParams();
  if (options.after !== undefined) {
    if (!Number.isSafeInteger(options.after) || options.after < 0) {
      throw new RangeError('`after` must be a non-negative integer event sequence');
    }
    query.set('after', String(options.after));
  }
  if (options.speed !== undefined) {
    if (!demoReplaySpeedSchema.safeParse(String(options.speed)).success) {
      throw new RangeError(
        `\`speed\` must be between ${DEMO_REPLAY_SPEED.min} and ${DEMO_REPLAY_SPEED.max} with at most two decimals`,
      );
    }
    query.set('speed', String(options.speed));
  }
  const search = query.toString();
  return search === '' ? demoRunPath(runId, 'events') : `${demoRunPath(runId, 'events')}?${search}`;
}

/** `GET` Gate 1 as decided (`factConflictsGateResponseSchema`). */
export function demoFactConflictsGateUrl(runId: string): string {
  return demoRunPath(runId, 'gates', 'fact-conflicts');
}

/** `GET` Gate 2 as decided (`demoClaimAuditGateResponseSchema`). */
export function demoClaimAuditGateUrl(runId: string): string {
  return demoRunPath(runId, 'gates', 'claim-audit');
}

/** An original photo or the voice memo, Range-capable. */
export function demoMaterialFileUrl(
  runId: string,
  materialId: string,
  options: { download?: boolean } = {},
): string {
  return withDownload(demoRunPath(runId, 'materials', materialId, 'file'), options.download);
}

/** An image artifact's file: a staged image or an exported JPEG. */
export function demoArtifactFileUrl(
  runId: string,
  artifactId: string,
  options: { download?: boolean } = {},
): string {
  return withDownload(demoRunPath(runId, 'artifacts', artifactId, 'file'), options.download);
}

/** The voice memo a transcript was made from, Range-capable (seek to `startMs / 1000`). */
export function demoTranscriptAudioUrl(runId: string, transcriptArtifactId: string): string {
  return demoRunPath(runId, 'transcripts', transcriptArtifactId, 'audio');
}

/** The mask overlay of a `photo_region` fact (see `RUN_FACT_MASK_PNG`). */
export function demoFactMaskUrl(runId: string, factId: string): string {
  return demoRunPath(runId, 'facts', factId, 'mask.png');
}

/** `GET` the export manifest (`demoRunExportResponseSchema`). */
export function demoExportUrl(runId: string): string {
  return demoRunPath(runId, 'export');
}

/** One file of the export manifest; the HTML pack is viewable inline, the JSON always downloads. */
export function demoExportFileUrl(
  runId: string,
  artifactId: string,
  options: { download?: boolean } = {},
): string {
  return withDownload(demoRunPath(runId, 'export', 'files', artifactId), options.download);
}
