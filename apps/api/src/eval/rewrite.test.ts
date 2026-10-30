import { describe, expect, it } from 'vitest';
import type { Interaction } from '../meta/fixtures.ts';
import { COPY_OUTPUT_NAME } from '../pipeline/creative/prompt.ts';
import { QA_OUTPUT_NAME } from '../pipeline/qa/prompt.ts';
import { createInjectionRewrite } from './rewrite.ts';
import { injectionSchema } from './sets.ts';

const facts = [
  {
    id: 'VF01',
    key: 'living_area',
    label: 'Living area',
    value: 92,
    unit: 'm2',
    basis: 'NEN2580',
    presence: false,
    seenIn: [],
  },
];

function input(revision: unknown) {
  return {
    language: { code: 'en', name: 'English' },
    tone: null,
    market: {
      id: 'nl',
      currency: 'EUR',
      units: { area: 'm2', volume: 'm3' },
      areaBases: [{ id: 'NEN2580', label: 'NEN 2580' }],
    },
    facts,
    photos: null,
    revision,
  };
}

const copyDraft = {
  portal: { paragraphs: [{ segments: [{ text: 'It offers 92 m².', factIds: ['VF01'] }] }] },
  social: { segments: [{ text: 'Home of 92 m².', factIds: ['VF01'] }] },
};

function request(name: string, prompt: unknown) {
  return {
    method: 'POST',
    path: '/v1/responses',
    body: JSON.stringify({
      model: 'muse-spark-1.3',
      input: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(prompt) }] },
      ],
      text: { format: { type: 'json_schema', name, strict: true } },
    }),
  };
}

function answer(output: unknown): Interaction {
  return {
    request: { method: 'POST', path: '/v1/responses', bodySha256: '0'.repeat(64) },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        type: 'json',
        value: {
          id: 'resp_1',
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [
            { type: 'reasoning', id: 'rs_1', summary: [] },
            {
              type: 'message',
              id: 'msg_1',
              content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }],
            },
          ],
        },
      },
    },
  };
}

function outputOf(interaction: Interaction): unknown {
  const body = interaction.response.body;
  if (body.type !== 'json') throw new Error('expected JSON');
  const text = JSON.stringify(body.value);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || !('output' in parsed)) throw new Error('x');
  const output = parsed.output;
  if (!Array.isArray(output)) throw new Error('no output');
  const message: unknown = output[1];
  if (typeof message !== 'object' || message === null || !('content' in message)) {
    throw new Error('no message');
  }
  const content = message.content;
  if (!Array.isArray(content)) throw new Error('no content');
  const part: unknown = content[0];
  if (typeof part !== 'object' || part === null || !('text' in part)) throw new Error('no text');
  return typeof part.text === 'string' ? JSON.parse(part.text) : undefined;
}

const injections = [
  injectionSchema.parse({
    id: 'plus',
    description: 'test',
    variant: 'portal',
    op: 'replace_number',
    target: '^living_area$',
    delta: 4,
    expect: { category: 'claim_support', detector: 'validator' },
  }),
  injectionSchema.parse({
    id: 'qa-plus',
    description: 'test',
    variant: 'qa',
    op: 'replace_number',
    target: '^living_area$',
    delta: 5,
    expect: { category: 'claim_support', detector: 'validator' },
  }),
];

describe('createInjectionRewrite', () => {
  it('injects into the first copy draft and keeps the rest of the answer', () => {
    const rewrite = createInjectionRewrite(injections);
    const original = answer(copyDraft);
    const result = rewrite.rewriteResponse(request(COPY_OUTPUT_NAME, input(null)), original);
    expect(outputOf(result)).toEqual({
      ...copyDraft,
      portal: { paragraphs: [{ segments: [{ text: 'It offers 96 m².', factIds: ['VF01'] }] }] },
    });
    // Usage, IDs, and the reasoning item are untouched; the recorded interaction is not mutated.
    expect(result.response.body).toMatchObject({
      value: { id: 'resp_1', usage: { input_tokens: 1 } },
    });
    expect(outputOf(original)).toEqual(copyDraft);
    expect(rewrite.applied().map((a) => a.id)).toEqual(['plus']);
    expect(rewrite.seen).toEqual({ copy: 1, qa: 0 });
  });

  it('leaves revisions, other requests, and unparseable answers alone', () => {
    const rewrite = createInjectionRewrite(injections);
    const revision = {
      draft: copyDraft,
      flags: [{ variant: 'portal', segment: 0, problem: 'Wrong number.' }],
    };
    const revised = answer(copyDraft);
    expect(rewrite.rewriteResponse(request(COPY_OUTPUT_NAME, input(revision)), revised)).toBe(
      revised,
    );
    const other = answer({ flags: [] });
    expect(rewrite.rewriteResponse(request('claim_audit', { any: 1 }), other)).toBe(other);
    const broken = answer('not a draft');
    expect(rewrite.rewriteResponse(request(COPY_OUTPUT_NAME, input(null)), broken)).toBe(broken);
    expect(rewrite.applied()).toEqual([]);
  });

  it('injects Q&A answers into the first Q&A draft', () => {
    const rewrite = createInjectionRewrite(injections);
    const { photos: _photos, ...qaInput } = input(null);
    const cards = {
      cards: [{ question: 'How large?', answer: [{ text: 'It is 92 m².', factIds: ['VF01'] }] }],
    };
    const result = rewrite.rewriteResponse(request(QA_OUTPUT_NAME, qaInput), answer(cards));
    expect(outputOf(result)).toEqual({
      cards: [{ question: 'How large?', answer: [{ text: 'It is 97 m².', factIds: ['VF01'] }] }],
    });
    expect(rewrite.applied().map((a) => a.id)).toEqual(['qa-plus']);
  });
});
