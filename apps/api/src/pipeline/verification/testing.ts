// Test support for the verification step, shared by the record/replay tests and the integration
// test so all of them send exactly the requests the P3-06 fixtures were recorded with. The
// initial drafts are the P3-01 recordings (replayed in both modes), optionally with seeded
// defects. Imported only by tests.
import {
  listingCopyContentSchema,
  qaCardsContentSchema,
  type ListingCopyContent,
  type QaCardsContent,
  type ServiceDefinition,
} from '@evidomo/shared';
import type { Fact } from '../../db/repositories/facts.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type { MetaClients } from '../../meta/clients.ts';
import type { UsageRecorder } from '../../meta/usage.ts';
import type { StepConfig } from '../../runs/steps.ts';
import { storedFact } from '../reconciliation/testing.ts';
import { checkQaOutput } from '../qa/check.ts';
import {
  buildQaCardsContent,
  buildQaInput,
  buildQaRequests,
  callQa,
  validateQa,
} from '../qa/generate.ts';
import { QA_CASSETTES, recordedQaSources, recordedQaStep } from '../qa/testing.ts';
import { checkCopyOutput } from '../creative/check.ts';
import {
  buildCopyInput,
  buildCopyRequests,
  buildListingCopyContent,
  callCopy,
  validateCopy,
  type CopySources,
} from '../creative/generate.ts';
import {
  COPY_CASSETTES,
  COPY_INCLUDED_CASSETTES,
  placeholderArtifactIds,
  recordedCopySources,
  recordedCopyStep,
  replayPostGateFacts,
  type PostGateFacts,
  type RecordedCopyLanguage,
} from '../creative/testing.ts';

export { COPY_MATCH as VERIFICATION_MATCH } from '../creative/testing.ts';

export const VERIFICATION_SCENARIOS = {
  /** The recorded en draft as written. */
  'loop-en': { language: 'en', edits: 'none', qa: 'absent' },
  /** The recorded nl draft as written. */
  'loop-nl': { language: 'nl', edits: 'none', qa: 'absent' },
  /** The recorded en draft with the defects of {@link SEEDED_EN_DEFECTS}. */
  'seeded-en': { language: 'en', edits: 'seeded', qa: 'absent' },
  /** The recorded en draft with its one flagged segment as the loop-en revision rewrote it. */
  'clean-en': { language: 'en', edits: 'clean', qa: 'absent' },
  /**
   * P3-03: the recorded en draft as written, audited together with the recorded en Q&A cards
   * carrying the defects of {@link SEEDED_QA_EN_DEFECTS}, so the loop revises the cards only.
   */
  'qa-en': { language: 'en', edits: 'none', qa: 'seeded' },
  /** P3-03: the recorded en draft and the recorded en Q&A cards, both as written. */
  'qa-clean-en': { language: 'en', edits: 'none', qa: 'recorded' },
} as const satisfies Record<
  string,
  {
    language: RecordedCopyLanguage;
    edits: 'none' | 'seeded' | 'clean';
    /**
     * `absent`: no Q&A step (the P3-06 requests); `recorded`: the recorded P3-03 cards as
     * written; `seeded`: the same cards with {@link SEEDED_QA_EN_DEFECTS}.
     */
    qa: 'absent' | 'recorded' | 'seeded';
  }
>;
export type VerificationScenario = keyof typeof VERIFICATION_SCENARIOS;

export function verificationCassette(scenario: VerificationScenario): string {
  return `p3-06/${scenario}`;
}

/** Earlier recordings served read-only: the post-Gate-1 facts and both P3-01 drafts. */
export const VERIFICATION_INCLUDED_CASSETTES = [
  ...COPY_INCLUDED_CASSETTES,
  COPY_CASSETTES.en,
  COPY_CASSETTES.nl,
  QA_CASSETTES.en,
  QA_CASSETTES.nl,
] as const;

/**
 * The verification step of `listing-launch` v1 with the settings the fixtures were recorded
 * with, so they keep matching if the definition's defaults change later.
 */
export function recordedVerifierStep(
  registry: Pick<DefinitionRegistry, 'getService'>,
): StepConfig<'verifier'> {
  const service = registry.getService('listing-launch', 1);
  const step = service.steps.find((candidate) => candidate.agent === 'verifier');
  if (step?.agent !== 'verifier') throw new Error('listing-launch v1 has no verifier step');
  return {
    ...step,
    model: 'muse-wonder-1.0',
    reasoning_effort: 'low',
    max_output_tokens: 12000,
    fallback_model: 'muse-spark-1.3',
    fallback_reasoning_effort: 'medium',
    max_revision_loops: 2,
    gate_after: 'claim_audit',
  };
}

/** Creative copy, verification (stops at Gate 2), then an export stand-in. */
export function verificationService(
  registry: Pick<DefinitionRegistry, 'getService'>,
): ServiceDefinition {
  const service = registry.getService('listing-launch', 1);
  return {
    ...service,
    id: 'copy-verification',
    steps: [
      recordedCopyStep(registry),
      recordedVerifierStep(registry),
      { id: 'export', agent: 'exporter' },
    ],
  };
}

export interface RecordedDraft {
  readonly recorded: PostGateFacts;
  readonly facts: readonly Fact[];
  readonly sources: CopySources;
  /** Revision 0 as the creative step stores it (validated). */
  readonly content: ListingCopyContent;
}

/** The P3-01 draft for a language, rebuilt from the replayed facts and copy answer. */
export async function recordedInitialDraft(
  clients: MetaClients,
  usage: UsageRecorder,
  registry: Pick<DefinitionRegistry, 'getService' | 'getMarket'>,
  language: RecordedCopyLanguage,
): Promise<RecordedDraft> {
  const recorded = await replayPostGateFacts(clients, usage, registry, placeholderArtifactIds());
  const facts = recorded.facts.map((fact) => storedFact('run', fact));
  const sources = recordedCopySources(registry, facts, recorded.inventory, language);
  const input = buildCopyInput(sources);
  const { primary } = buildCopyRequests(recordedCopyStep(registry), sources.market, input);
  const answer = await callCopy(clients, primary);
  const content = buildListingCopyContent({
    generated: {
      copy: checkCopyOutput(answer.output, sources.catalog, language),
      modelRun: {
        model: primary.modelId,
        reasoningEffort: primary.reasoningEffort,
        maxOutputTokens: primary.maxOutputTokens,
        fallbackFrom: null,
      },
    },
    catalog: sources.catalog,
    facts: sources.facts,
    input,
    revision: 0,
    previousArtifactId: null,
  });
  return { recorded, facts, sources, content };
}

/**
 * The seeded defects, by the recorded en segment's exact text (fictional town). Each needs
 * either the claim validator or the verifier to catch it.
 */
export const SEEDED_EN_DEFECTS = [
  {
    category: 'unverifiable_superlative',
    source: 'verifier',
    original: 'It was built in 1987 and has energy label B.',
    seeded:
      'It was built in 1987 and has energy label B, making it one of the most sought-after homes in Zandmeer.',
  },
  {
    category: 'exclusionary',
    source: 'verifier',
    original: 'A bedroom of 9 m² is currently used as home office.',
    seeded: 'A bedroom of 9 m² is currently used as home office, perfect for a young family.',
  },
  {
    category: 'investment_promise',
    source: 'verifier',
    original: 'The VvE contribution is €165 per month.',
    seeded:
      'The VvE contribution is €165 per month, so this is a safe investment that will rise in value.',
  },
  {
    category: 'area_basis',
    source: 'verifier',
    original:
      'French doors from the living room open to the 7 m² southwest balcony with afternoon sun.',
    seeded:
      'French doors from the living room open to the 7 m² southwest balcony with afternoon sun, which adds to the living space.',
  },
  {
    category: 'claim_support',
    source: 'validator',
    original:
      'A bedroom on the front side measures 14 m² and has a fitted wardrobe over the full width.',
    seeded:
      'A bedroom on the front side measures 15 m² and has a fitted wardrobe over the full width.',
  },
] as const;

/**
 * Edits that make the recorded en draft clean. Empty since the vision prompt version 2
 * re-recording: that draft passed its first audit without a flag (loop-en), so clean-en audits
 * it unchanged and its verifier request is byte-identical to loop-en's first pass.
 */
export const CLEAN_EN_EDITS: readonly { readonly original: string; readonly seeded: string }[] = [];

/** The draft with segment texts replaced (same citations) and validated again. */
export function editDraft(
  content: ListingCopyContent,
  sources: CopySources,
  edits: readonly { readonly original: string; readonly seeded: string }[],
): ListingCopyContent {
  const replacements = new Map<string, string>(edits.map((d) => [d.original, d.seeded]));
  const used = new Set<string>();
  const variants = content.variants.map((variant) => ({
    ...variant,
    segments: variant.segments.map((segment) => {
      const seeded = replacements.get(segment.text);
      if (seeded === undefined) return segment;
      used.add(segment.text);
      return { ...segment, text: seeded };
    }),
  }));
  if (used.size !== replacements.size) {
    throw new Error('The recorded draft no longer contains every segment to edit');
  }
  return listingCopyContentSchema.parse({
    ...content,
    variants,
    validation: validateCopy(variants, sources.facts, content.outputLanguage),
  });
}

/** The initial draft of a scenario: the recording as written, seeded, or cleaned. */
export function scenarioDraft(
  scenario: VerificationScenario,
  draft: RecordedDraft,
): ListingCopyContent {
  const { edits } = VERIFICATION_SCENARIOS[scenario];
  switch (edits) {
    case 'none':
      return draft.content;
    case 'seeded':
      return editDraft(draft.content, draft.sources, SEEDED_EN_DEFECTS);
    case 'clean':
      return editDraft(draft.content, draft.sources, CLEAN_EN_EDITS);
    default: {
      const unreachable: never = edits;
      throw new Error(`Unknown scenario edits ${String(unreachable)}`);
    }
  }
}

/** The P3-03 Q&A cards for a language, rebuilt from the replayed facts and Q&A answer. */
export async function recordedInitialQa(
  clients: MetaClients,
  registry: Pick<DefinitionRegistry, 'getService' | 'getMarket'>,
  draft: RecordedDraft,
  language: RecordedCopyLanguage,
): Promise<QaCardsContent> {
  const sources = recordedQaSources(registry, draft.facts, draft.recorded.inventory, language);
  const input = buildQaInput(sources);
  const { primary } = buildQaRequests(recordedQaStep(registry), sources.market, input);
  const answer = await callQa(clients, primary);
  return buildQaCardsContent({
    generated: {
      qa: checkQaOutput(answer.output, sources.catalog, language),
      modelRun: {
        model: primary.modelId,
        reasoningEffort: primary.reasoningEffort,
        maxOutputTokens: primary.maxOutputTokens,
        fallbackFrom: null,
      },
    },
    catalog: sources.catalog,
    facts: sources.facts,
    input,
    revision: 0,
    previousArtifactId: null,
  });
}

/**
 * Seeded defects in the recorded en Q&A cards (fictional town), by exact text: a question that
 * addresses buyers by family status, a changed number, and a promise. `question` defects replace
 * a card's question; the verifier flags them on the card's first answer segment.
 */
export const SEEDED_QA_EN_DEFECTS = [
  {
    kind: 'question',
    category: 'exclusionary',
    source: 'verifier',
    original: 'What outdoor space is available?',
    seeded: 'Is the outdoor space suitable for a young family with children?',
  },
  {
    kind: 'answer',
    category: 'claim_support',
    source: 'validator',
    original: 'There is external storage of 6 m².',
    seeded: 'There is external storage of 8 m².',
  },
  {
    kind: 'answer',
    category: 'investment_promise',
    source: 'verifier',
    original: 'The station is 10 minutes away by bicycle.',
    seeded: 'The station is 10 minutes away by bicycle, so the home is sure to rise in value.',
  },
] as const;

/** The cards with questions and answer texts replaced (same citations) and validated again. */
export function editQa(
  content: QaCardsContent,
  sources: CopySources,
  edits: readonly { readonly original: string; readonly seeded: string }[],
): QaCardsContent {
  const replacements = new Map<string, string>(edits.map((d) => [d.original, d.seeded]));
  const used = new Set<string>();
  const replace = (text: string): string => {
    const seeded = replacements.get(text);
    if (seeded === undefined) return text;
    used.add(text);
    return seeded;
  };
  const cards = content.cards.map((card) => ({
    ...card,
    question: replace(card.question),
    segments: card.segments.map((segment) => ({ ...segment, text: replace(segment.text) })),
  }));
  if (used.size !== replacements.size) {
    throw new Error('The recorded Q&A cards no longer contain every text to edit');
  }
  return qaCardsContentSchema.parse({
    ...content,
    cards,
    validation: validateQa(cards, sources.facts, content.outputLanguage),
  });
}
