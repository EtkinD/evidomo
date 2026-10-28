import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  TRANSCRIPT_ARTIFACT_KIND,
  transcriptArtifactContentSchema,
  transcriptStoredPayloadSchema,
  voiceMemoMaterialMetadataSchema,
  type JsonObject,
  type MarketProfile,
  type ServiceDefinition,
  type TranscriptArtifactContent,
} from '@evidomo/shared';
import { insertSingletonArtifact } from '../../db/repositories/artifacts.ts';
import { listMaterials, type Material } from '../../db/repositories/materials.ts';
import { getProject } from '../../db/repositories/projects.ts';
import { appendRunEvent } from '../../db/repositories/run-events.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import {
  TRANSCRIBE_MAX_BYTES,
  TranscriptionInputError,
  transcribeAudio,
  type TranscribeRequest,
} from '../../meta/transcribe.ts';
import { NonRetryableStepError, type StepConfig, type StepHandler } from '../../runs/steps.ts';
import { StorageNotFoundError, type Storage } from '../../storage/storage.ts';
import { buildTranscriptionKeywords, languageBiasFor } from './keywords.ts';
import { toStoredTurns } from './turns.ts';

// Step 1, intake (docs/architecture.md §5): the project's voice memo → Voice Transcribe with
// keyword biasing from the fact form and market profile → a `transcript` artifact whose turns
// are the evidence anchors of transcript claims (§6). Transcript text and keywords are personal
// data: they go into the artifact (which cascades with the project), never into logs or events.

/**
 * The multipart filename sent with every memo. The server does not interpret it; a fixed name
 * keeps material IDs out of the request and is the declared key of the replay fixtures.
 */
export const INTAKE_AUDIO_FILE_NAME = 'voice-memo.wav';

/** Per-attempt HTTP timeout: P1-04 measured ~0.2x real time; leave generous headroom. */
const MIN_TRANSCRIBE_TIMEOUT_MS = 180_000;

export function transcribeTimeoutMs(durationMs: number): number {
  return Math.max(MIN_TRANSCRIBE_TIMEOUT_MS, 60_000 + Math.ceil(durationMs / 2));
}

export interface IntakeRequestInput {
  readonly step: StepConfig<'intake'>;
  readonly market: MarketProfile;
  readonly factForm: JsonObject;
  readonly audio: Uint8Array;
  readonly durationMs: number;
  readonly signal?: AbortSignal;
}

/**
 * The Voice Transcribe request for one memo. Model and mode come from the step configuration,
 * biasing from the fact form and market profile; everything is deterministic for equal input.
 */
export function buildIntakeTranscribeRequest(input: IntakeRequestInput): TranscribeRequest {
  const keywords = buildTranscriptionKeywords({ factForm: input.factForm, market: input.market });
  return {
    model: input.step.model,
    mode: input.step.transcription_mode,
    audio: input.audio,
    fileName: INTAKE_AUDIO_FILE_NAME,
    keywords,
    languageBias: languageBiasFor(input.market),
    timeoutMs: transcribeTimeoutMs(input.durationMs),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

export interface IntakeHandlerDeps {
  readonly storage: Storage;
  readonly markets: Pick<DefinitionRegistry, 'getMarket'>;
}

/** The `audio` input of the service, whose `max_seconds` bounds the memo. */
function audioInputLimitMs(service: ServiceDefinition): number | undefined {
  const input = service.inputs.find((candidate) => candidate.type === 'audio');
  return input?.type === 'audio' ? input.max_seconds * 1000 : undefined;
}

/**
 * The memo to transcribe: the single `ready` voice memo uploaded before the run was created, so
 * a retry days later cannot pick up a newer upload. The service takes one memo; several are
 * refused rather than silently choosing one.
 */
function selectVoiceMemo(materials: readonly Material[], runCreatedAt: Date): Material {
  const ready = materials.filter(
    (material) =>
      material.kind === 'voice_memo' &&
      material.status === 'ready' &&
      material.createdAt.getTime() <= runCreatedAt.getTime(),
  );
  const [memo] = ready;
  if (memo === undefined) {
    throw new NonRetryableStepError('The project has no processed voice memo to transcribe');
  }
  if (ready.length > 1) {
    throw new NonRetryableStepError(
      `The project has ${ready.length} processed voice memos; the service accepts exactly one`,
    );
  }
  return memo;
}

async function readAll(stream: Readable, limitBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) {
      stream.destroy();
      throw new Error('Storage returned a non-binary stream for the voice memo');
    }
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    total += buffer.byteLength;
    if (total > limitBytes) {
      stream.destroy();
      throw new NonRetryableStepError('The stored voice memo exceeds the transcription size limit');
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

async function readVoiceMemo(storage: Storage, memo: Material): Promise<Uint8Array> {
  if (memo.sizeBytes > TRANSCRIBE_MAX_BYTES) {
    throw new NonRetryableStepError('The stored voice memo exceeds the transcription size limit');
  }
  let stream: Readable;
  try {
    stream = await storage.get(memo.storageKey);
  } catch (error) {
    if (error instanceof StorageNotFoundError) {
      throw new NonRetryableStepError('The stored voice memo file is missing', { cause: error });
    }
    throw error;
  }
  const bytes = await readAll(stream, TRANSCRIBE_MAX_BYTES);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== memo.sha256) {
    throw new NonRetryableStepError('The stored voice memo does not match its recorded checksum');
  }
  return bytes;
}

export function createIntakeHandler(deps: IntakeHandlerDeps): StepHandler<'intake'> {
  return async (ctx) => {
    const { run, step, service } = ctx;
    const project = await getProject(ctx.db, run.projectId);
    if (project === undefined) throw new NonRetryableStepError('The run has no project');
    const market = deps.markets.getMarket(run.marketProfileId, run.marketProfileVersion);

    const memo = selectVoiceMemo(
      await listMaterials(ctx.db, project.id, { kind: 'voice_memo' }),
      run.createdAt,
    );
    const metadata = voiceMemoMaterialMetadataSchema.safeParse(memo.metadata);
    if (!metadata.success) {
      throw new NonRetryableStepError('The voice memo has no valid processing metadata');
    }
    const limitMs = audioInputLimitMs(service);
    if (limitMs !== undefined && metadata.data.durationMs > limitMs) {
      throw new NonRetryableStepError(
        `The voice memo is ${Math.ceil(metadata.data.durationMs / 1000)} s long; the service accepts at most ${limitMs / 1000} s`,
      );
    }
    const audio = await readVoiceMemo(deps.storage, memo);

    const request = buildIntakeTranscribeRequest({
      step,
      market,
      factForm: project.factForm,
      audio,
      durationMs: metadata.data.durationMs,
      signal: ctx.signal,
    });
    const clients = ctx.metaClients();
    const transcript = await ctx.ledger.meter(step.model, async () => {
      try {
        return await transcribeAudio(
          {
            openai: clients.openai,
            // The clients' recorder is this execution's ledger; recordUsage adds the estimate.
            usage: { record: (entry) => void clients.recordUsage(entry) },
          },
          request,
        );
      } catch (error) {
        if (error instanceof TranscriptionInputError) {
          // Our own validation text (format, size, duration): no customer content.
          throw new NonRetryableStepError(
            `The voice memo cannot be transcribed: ${error.message}`,
            {
              cause: error,
            },
          );
        }
        throw error;
      }
    });

    const maxTurnMs = step.max_turn_seconds === undefined ? null : step.max_turn_seconds * 1000;
    const turns = toStoredTurns(transcript.turns, { maxTurnMs });
    if (turns.length === 0) {
      // Silence or a mode without turns: nothing could ever be cited, so later steps would run
      // on no evidence. A retry would transcribe the same audio again.
      throw new NonRetryableStepError('The transcription returned no speech turns');
    }
    const content: TranscriptArtifactContent = transcriptArtifactContentSchema.parse({
      schemaVersion: 1,
      materialId: memo.id,
      materialSha256: memo.sha256,
      model: step.model,
      mode: step.transcription_mode,
      sessionId: transcript.sessionId,
      audioDurationMs: transcript.audioDurationMs,
      languageBias: [...(request.languageBias ?? [])],
      keywords: [...(request.keywords ?? [])],
      maxTurnMs,
      turns,
    } satisfies TranscriptArtifactContent);
    const summary = {
      mode: content.mode,
      audioDurationMs: content.audioDurationMs,
      sourceTurnCount: new Set(turns.map((turn) => turn.sourceTurnIndex)).size,
      turnCount: turns.length,
      approximateTurnCount: turns.filter((turn) => turn.timing === 'approximate').length,
      speakerCount: new Set(turns.flatMap((turn) => (turn.speaker === null ? [] : [turn.speaker])))
        .size,
      keywordCount: content.keywords.length,
    };
    ctx.logger.info(summary, 'transcript ready');

    return {
      async commit(tx) {
        const { artifact, created } = await insertSingletonArtifact(tx, {
          runId: run.id,
          stepId: step.id,
          kind: TRANSCRIPT_ARTIFACT_KIND,
          content,
        });
        if (created) {
          await appendRunEvent(tx, run.id, {
            type: 'transcript_stored',
            payload: transcriptStoredPayloadSchema.parse({
              stepId: step.id,
              artifactId: artifact.id,
              ...summary,
            }),
          });
        } else {
          ctx.logger.warn(
            { artifactId: artifact.id },
            'transcript already stored for this step; keeping the existing one',
          );
        }
        return { artifactIds: [artifact.id] };
      },
    };
  };
}
