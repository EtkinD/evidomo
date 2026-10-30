import { z } from 'zod';
import type { Interaction } from '../meta/fixtures.ts';
import type { RewriteRequest } from '../meta/replay.ts';
import { COPY_OUTPUT_NAME } from '../pipeline/creative/prompt.ts';
import { copyDraftSchema, copyInputSchema } from '../pipeline/creative/schema.ts';
import { QA_OUTPUT_NAME } from '../pipeline/qa/prompt.ts';
import { qaDraftSchema, qaInputSchema } from '../pipeline/qa/schema.ts';
import {
  injectCopyDraft,
  injectQaDraft,
  type AppliedInjection,
  type SkippedInjection,
} from './inject.ts';
import type { Injection } from './sets.ts';

// The eval's seam into a run (docs/architecture.md §12 "Seeded-defect eval"): a response rewrite
// for the Meta replay (`MetaReplayOptions.rewriteResponse`) that injects the set's defects into
// the creative and Q&A steps' first answers (requests without a `revision`). Everything after it
// is the production path: the output check, the claim validator, storage, the verifier, the
// revision loop, Gate 2, and the export. Cassettes keep the model's original answer.

/** The parts of a Responses API request body the rewrite reads. */
const responsesRequestSchema = z.object({
  input: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string(), text: z.string().optional() })),
      ]),
    }),
  ),
  text: z.object({ format: z.object({ name: z.string().optional() }) }).optional(),
});

/** A Responses API answer as JSON objects, so a rewritten copy stays a valid fixture body. */
const jsonObjectSchema = z.record(z.string(), z.json());
const answerSchema = z.object({ output: z.array(jsonObjectSchema) });
const messageContentSchema = z.array(jsonObjectSchema);

export class InjectionRewriteError extends Error {
  override name = 'InjectionRewriteError';
}

function userText(body: z.infer<typeof responsesRequestSchema>): string {
  return body.input
    .filter((item) => item.role === 'user')
    .map((item) =>
      typeof item.content === 'string'
        ? item.content
        : item.content
            .map((part) => (part.type === 'input_text' ? (part.text ?? '') : ''))
            .join(''),
    )
    .join('');
}

/** The message parts of an answer that hold its output text. */
function outputTexts(value: unknown): { text: string }[] {
  const answer = answerSchema.parse(value);
  return answer.output.flatMap((item) => {
    if (item['type'] !== 'message') return [];
    return messageContentSchema
      .parse(item['content'])
      .filter((part) => part['type'] === 'output_text')
      .map((part) => ({ text: typeof part['text'] === 'string' ? part['text'] : '' }));
  });
}

function outputText(interaction: Interaction): string {
  const body = interaction.response.body;
  if (body.type !== 'json') throw new InjectionRewriteError('The answer is not JSON');
  const texts = outputTexts(body.value);
  const [first] = texts;
  if (texts.length !== 1 || first === undefined) {
    throw new InjectionRewriteError(
      `Expected one output text in the answer, found ${texts.length}`,
    );
  }
  return first.text;
}

/** The answer with its single output text replaced (a copy; the cassette keeps the original). */
function withOutputText(interaction: Interaction, text: string): Interaction {
  const body = interaction.response.body;
  if (body.type !== 'json') throw new InjectionRewriteError('The answer is not JSON');
  outputText(interaction);
  const value = jsonObjectSchema.parse(body.value);
  const output = answerSchema.parse(value).output.map((item) => {
    if (item['type'] !== 'message') return item;
    const content = messageContentSchema
      .parse(item['content'])
      .map((part) => (part['type'] === 'output_text' ? { ...part, text } : part));
    return { ...item, content };
  });
  return {
    ...interaction,
    response: { ...interaction.response, body: { ...body, value: { ...value, output } } },
  };
}

export interface InjectionRewrite {
  readonly rewriteResponse: (request: RewriteRequest, interaction: Interaction) => Interaction;
  /** What was injected, once per injection (an engine retry injects the same text again). */
  applied(): readonly AppliedInjection[];
  skipped(): readonly SkippedInjection[];
  /** The first-draft requests seen, by output name: an eval without them injected nothing. */
  readonly seen: { copy: number; qa: number };
}

/**
 * A rewrite that injects `injections` into first drafts. An answer the model truncated or that
 * does not parse is passed through unchanged: the pipeline then fails or retries it as usual.
 */
export function createInjectionRewrite(injections: readonly Injection[]): InjectionRewrite {
  const applied = new Map<string, AppliedInjection>();
  const skipped = new Map<string, SkippedInjection>();
  const seen = { copy: 0, qa: 0 };
  const copyInjections = injections.filter((i) => i.variant !== 'qa');
  const qaInjections = injections.filter((i) => i.variant === 'qa');

  function record(result: {
    applied: readonly AppliedInjection[];
    skipped: readonly SkippedInjection[];
  }): void {
    for (const entry of result.applied) applied.set(entry.id, entry);
    for (const entry of result.skipped) skipped.set(entry.id, entry);
  }

  return {
    seen,
    applied: () => [...applied.values()],
    skipped: () => [...skipped.values()],
    rewriteResponse(request, interaction) {
      if (request.method !== 'POST' || request.path !== '/v1/responses') return interaction;
      if (injections.length === 0) return interaction;
      let body: z.infer<typeof responsesRequestSchema>;
      try {
        const parsed = responsesRequestSchema.safeParse(JSON.parse(request.body));
        if (!parsed.success) return interaction;
        body = parsed.data;
      } catch {
        // Not JSON (e.g. a multipart upload): nothing to inject into.
        return interaction;
      }
      const name = body.text?.format.name;
      if (name !== COPY_OUTPUT_NAME && name !== QA_OUTPUT_NAME) return interaction;
      let prompt: unknown;
      try {
        prompt = JSON.parse(userText(body));
      } catch (error) {
        throw new InjectionRewriteError(`The ${name} request has no JSON user message`, {
          cause: error,
        });
      }
      let answer: unknown;
      try {
        answer = JSON.parse(outputText(interaction));
      } catch {
        return interaction;
      }
      if (name === COPY_OUTPUT_NAME) {
        const input = copyInputSchema.parse(prompt);
        const draft = copyDraftSchema.safeParse(answer);
        if (input.revision !== null || !draft.success) return interaction;
        seen.copy += 1;
        if (copyInjections.length === 0) return interaction;
        const result = injectCopyDraft(draft.data, input.facts, copyInjections);
        record(result);
        return withOutputText(interaction, JSON.stringify(result.draft));
      }
      const input = qaInputSchema.parse(prompt);
      const draft = qaDraftSchema.safeParse(answer);
      if (input.revision !== null || !draft.success) return interaction;
      seen.qa += 1;
      if (qaInjections.length === 0) return interaction;
      const result = injectQaDraft(draft.data, input.facts, qaInjections);
      record(result);
      return withOutputText(interaction, JSON.stringify(result.draft));
    },
  };
}
