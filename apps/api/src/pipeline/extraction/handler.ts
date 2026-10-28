import {
  TRANSCRIPT_ARTIFACT_KIND,
  factsExtractedPayloadSchema,
  transcriptArtifactContentSchema,
  type JsonObject,
  type MarketProfile,
  type MetaReasoningEffort,
  type StoredTranscriptTurn,
} from '@evidomo/shared';
import { generateText, NoObjectGeneratedError, Output } from 'ai';
import { insertSingletonArtifact, listArtifacts } from '../../db/repositories/artifacts.ts';
import { insertFacts, type NewFact } from '../../db/repositories/facts.ts';
import { getProject } from '../../db/repositories/projects.ts';
import { appendRunEvent } from '../../db/repositories/run-events.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type { MetaClients } from '../../meta/clients.ts';
import { metaProviderOptions } from '../../meta/options.ts';
import { NonRetryableStepError, type StepConfig, type StepHandler } from '../../runs/steps.ts';
import { FactFormError, factFormToCandidates, type FormCandidates } from './form.ts';
import { normalizeExtractedFacts, type NormalizedExtraction } from './normalize.ts';
import { buildFactExtractionPrompt, buildFactExtractionSystemPrompt } from './prompt.ts';
import {
  FACT_EXTRACTION_ARTIFACT_KIND,
  FACT_EXTRACTION_PROMPT_VERSION,
  buildExtractionOutputSchema,
  factExtractionReportSchema,
  type ExtractionOutputSchema,
  type ExtractionRejectionReason,
  type FactExtractionReport,
  type FormCandidate,
  type RawExtractedFact,
  type TranscriptCandidate,
} from './schema.ts';

// Step 2, fact extraction (docs/architecture.md §5): fact form values (no model call) and
// Spark structured output over the intake transcript → candidate facts with provenance (§6:
// no source, no claim). Fact values, quotes, and transcript text are personal data: they go
// into the facts rows and the report artifact (both cascade with the project), never into
// logs or events.

/** Structured-output name sent to the API (and part of the fixture's request hash). */
export const FACT_EXTRACTION_OUTPUT_NAME = 'fact_extraction';

export interface FactExtractionRequest {
  readonly modelId: string;
  readonly reasoningEffort: MetaReasoningEffort;
  readonly maxOutputTokens: number;
  readonly system: string;
  readonly prompt: string;
  readonly schema: ExtractionOutputSchema;
}

/** The request for one transcript; model, effort, and token cap come from the step config. */
export function buildFactExtractionRequest(input: {
  readonly step: StepConfig<'extractor'>;
  readonly market: MarketProfile;
  readonly turns: readonly StoredTranscriptTurn[];
}): FactExtractionRequest {
  return {
    modelId: input.step.model,
    reasoningEffort: input.step.reasoning_effort,
    maxOutputTokens: input.step.max_output_tokens,
    system: buildFactExtractionSystemPrompt(input.market),
    prompt: buildFactExtractionPrompt(input.market, input.turns),
    schema: buildExtractionOutputSchema(input.market),
  };
}

export interface FactExtractionCallResult {
  readonly facts: readonly RawExtractedFact[];
  readonly finishReason: string;
  readonly warningCount: number;
  /** The raw response body, only with `includeResponseBody` (tests assert what Meta echoes). */
  readonly responseBody: unknown;
}

/**
 * One Spark call in strict `json_schema` mode. The SDK validates the answer against the zod
 * schema (and throws when it does not parse); usage is recorded by the clients' call hook.
 * Callers inside a step wrap this in `ctx.ledger.meter`.
 */
export async function callFactExtraction(
  clients: MetaClients,
  request: FactExtractionRequest,
  options: { readonly signal?: AbortSignal; readonly includeResponseBody?: boolean } = {},
): Promise<FactExtractionCallResult> {
  const result = await generateText({
    model: clients.languageModel(request.modelId),
    system: request.system,
    prompt: request.prompt,
    output: Output.object({ schema: request.schema, name: FACT_EXTRACTION_OUTPUT_NAME }),
    maxOutputTokens: request.maxOutputTokens,
    providerOptions: metaProviderOptions({ reasoningEffort: request.reasoningEffort }),
    include: { responseBody: options.includeResponseBody ?? false },
    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    ...clients.aiSdkCallOptions(),
  });
  return {
    facts: result.output.facts,
    finishReason: result.finishReason,
    warningCount: result.warnings?.length ?? 0,
    responseBody: result.response.body,
  };
}

/**
 * A truncated answer (`max_output_tokens` reached) cannot be parsed, and a retry at the same
 * cap would pay for the same truncation again, so it fails the run with an operator-safe
 * reason. Other errors pass through unchanged (the engine retries transient ones once).
 */
export function classifyExtractionError(error: unknown, maxOutputTokens: number): unknown {
  if (NoObjectGeneratedError.isInstance(error) && error.finishReason === 'length') {
    return new NonRetryableStepError(
      `Fact extraction reached max_output_tokens (${maxOutputTokens}) before the answer was complete; raise it in the service definition`,
      { cause: error },
    );
  }
  return error;
}

/** Counts per rejection reason, every reason present. */
function rejectionCounts(
  normalized: NormalizedExtraction,
): Record<ExtractionRejectionReason, number> {
  const counts: Record<ExtractionRejectionReason, number> = {
    unknown_turn: 0,
    quote_mismatch: 0,
    invalid_key: 0,
    invalid_value: 0,
    unit_mismatch: 0,
    duplicate: 0,
  };
  for (const rejected of normalized.rejected) counts[rejected.reason] += 1;
  return counts;
}

export function toFormFact(stepId: string, candidate: FormCandidate): NewFact {
  return {
    stepId,
    key: candidate.key,
    value: candidate.value,
    unit: candidate.unit,
    basis: candidate.basis,
    source: { kind: 'form', field: candidate.field },
    assertion: 'stated',
  };
}

export function toTranscriptFact(
  stepId: string,
  transcriptArtifactId: string,
  candidate: TranscriptCandidate,
): NewFact {
  return {
    stepId,
    key: candidate.key,
    value: candidate.value,
    unit: candidate.unit,
    basis: candidate.basis,
    source: {
      kind: 'transcript_turn',
      transcriptArtifactId,
      turnIndex: candidate.turnIndex,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      quote: candidate.quote,
    },
    assertion: candidate.assertion,
  };
}

function readForm(factForm: JsonObject, market: MarketProfile): FormCandidates {
  try {
    return factFormToCandidates(factForm, market);
  } catch (error) {
    // Field keys only (from the profile): no form values in the message.
    if (error instanceof FactFormError) {
      throw new NonRetryableStepError(error.message, { cause: error });
    }
    throw error;
  }
}

export interface FactExtractionHandlerDeps {
  readonly markets: Pick<DefinitionRegistry, 'getMarket'>;
}

export function createFactExtractionHandler(
  deps: FactExtractionHandlerDeps,
): StepHandler<'extractor'> {
  return async (ctx) => {
    const { run, step } = ctx;
    const project = await getProject(ctx.db, run.projectId);
    if (project === undefined) throw new NonRetryableStepError('The run has no project');
    const market = deps.markets.getMarket(run.marketProfileId, run.marketProfileVersion);

    const form = readForm(project.factForm, market);

    const transcripts = await listArtifacts(ctx.db, run.id, { kind: TRANSCRIPT_ARTIFACT_KIND });
    const [transcriptArtifact] = transcripts;
    if (transcriptArtifact === undefined) {
      throw new NonRetryableStepError('The run has no transcript to extract facts from');
    }
    if (transcripts.length > 1) {
      throw new NonRetryableStepError(
        `The run has ${transcripts.length} transcripts; fact extraction expects exactly one`,
      );
    }
    const transcript = transcriptArtifactContentSchema.safeParse(transcriptArtifact.content);
    if (!transcript.success) {
      throw new NonRetryableStepError('The run transcript has an invalid format');
    }
    const { turns } = transcript.data;

    const request = buildFactExtractionRequest({ step, market, turns });
    const clients = ctx.metaClients();
    const answer = await ctx.ledger.meter(step.model, async () => {
      try {
        return await callFactExtraction(clients, request, { signal: ctx.signal });
      } catch (error) {
        throw classifyExtractionError(error, request.maxOutputTokens);
      }
    });
    const normalized = normalizeExtractedFacts(market, turns, answer.facts);

    const accepted = normalized.accepted;
    const report: FactExtractionReport = factExtractionReportSchema.parse({
      schemaVersion: 1,
      promptVersion: FACT_EXTRACTION_PROMPT_VERSION,
      transcriptArtifactId: transcriptArtifact.id,
      model: request.modelId,
      reasoningEffort: request.reasoningEffort,
      maxOutputTokens: request.maxOutputTokens,
      counts: {
        formFacts: form.candidates.length,
        skippedFormFields: form.skippedFields,
        modelFacts: answer.facts.length,
        transcriptFacts: accepted.length,
        opinionFacts: accepted.filter((fact) => fact.assertion === 'opinion').length,
        repairedFacts: accepted.filter((fact) => fact.repaired).length,
        rejected: rejectionCounts(normalized),
      },
      rejected: normalized.rejected,
    } satisfies FactExtractionReport);
    const summary = {
      formFactCount: report.counts.formFacts,
      modelFactCount: report.counts.modelFacts,
      transcriptFactCount: report.counts.transcriptFacts,
      opinionCount: report.counts.opinionFacts,
      repairedCount: report.counts.repairedFacts,
      rejectedCount: normalized.rejected.length,
    };
    ctx.logger.info(summary, 'candidate facts extracted');

    const facts: NewFact[] = [
      ...form.candidates.map((candidate) => toFormFact(step.id, candidate)),
      ...accepted.map((candidate) => toTranscriptFact(step.id, transcriptArtifact.id, candidate)),
    ];

    return {
      async commit(tx) {
        // Idempotency: the report is a singleton per run and step, and the facts are inserted
        // only together with the first report, in one transaction. A repeated commit keeps the
        // first candidate set whole instead of merging two different model answers.
        const { artifact, created } = await insertSingletonArtifact(tx, {
          runId: run.id,
          stepId: step.id,
          kind: FACT_EXTRACTION_ARTIFACT_KIND,
          content: report,
        });
        if (created) {
          await insertFacts(tx, run.id, facts);
          await appendRunEvent(tx, run.id, {
            type: 'facts_extracted',
            payload: factsExtractedPayloadSchema.parse({
              stepId: step.id,
              artifactId: artifact.id,
              ...summary,
            }),
          });
        } else {
          ctx.logger.warn(
            { artifactId: artifact.id },
            'facts already extracted for this step; keeping the existing candidate set',
          );
        }
        return { artifactIds: [artifact.id] };
      },
    };
  };
}
