import { z } from 'zod';
import { claimValidationReportSchema } from './claims.ts';
import { copyCatalogEntrySchema, copyCatalogIdSchema, copyLanguageCheckSchema } from './copy.ts';
import { reconciliationModelRunSchema } from './reconciliation.ts';

// Buyer Q&A cards (docs/architecture.md §5 step 5, "Buyer Q&A cards (P3-03)"): questions a buyer
// asks, each answered by claim segments that cite verified facts, with the same contract as the
// listing copy. Shared because verification (P3-06), Gate 2 (P3-08), the publication checklist
// (P3-07), export (P3-09), and the web app read it. Questions and answers describe the property,
// so the artifact and its `claims` rows have the run's personal-data scope (they cascade with the
// project) and never go into events or logs.

export const QA_CARDS_ARTIFACT_KIND = 'qa_cards';

/**
 * The variant name of Q&A answer segments wherever a variant is named: the claim validator's
 * findings, the claim audit's flags (`Q01…`), and the publication checklist's `citedIn`.
 */
export const QA_VARIANT = 'qa';

/**
 * Bounds enforced in code after the model answers (strict mode does not enforce array sizes).
 * `maxCards`: cards beyond it are dropped in the model's order. `question`: characters after
 * whitespace normalization.
 */
export const QA_CARD_LIMITS = { minCards: 1, maxCards: 8, question: 200 } as const;

const count = z.int().nonnegative();

/** One answer segment: a sentence or clause and every fact it relies on (a claim). */
export const qaSegmentSchema = z.strictObject({
  /** Position across all cards of the artifact; `claims.segment_index`. */
  index: count,
  text: z.string().min(1).max(2000),
  /** Catalog IDs as the model cited them, de-duplicated, in its order. */
  catalogIds: z.array(copyCatalogIdSchema).min(1),
  /** Every stored fact behind those catalog IDs; `claims.fact_ids`. */
  factIds: z.array(z.uuid()).min(1),
});
export type QaSegment = z.infer<typeof qaSegmentSchema>;

/**
 * One card. The question is not a claim (no citations, no `claims` row): code requires it to
 * end with a question mark and to contain no number at all, and the verifier reads it with the
 * answer, so phrasing rules apply to it too.
 */
export const qaCardSchema = z.strictObject({
  /** 0-based position of the card in the artifact. */
  card: count,
  question: z.string().min(1).max(QA_CARD_LIMITS.question),
  segments: z.array(qaSegmentSchema).min(1),
});
export type QaCard = z.infer<typeof qaCardSchema>;

/** Deterministic repairs applied to the model's cards. */
export const qaRepairsSchema = z.strictObject({
  /** Uncited answer segments joined to a cited segment of the same card. */
  mergedUncited: count,
  /** Answer segments whose text was empty after trimming. */
  droppedEmpty: count,
  /** Cards removed whole, by reason. */
  droppedCards: z.strictObject({
    /** No answer segment cites a fact ("no source, no claim"). */
    uncited: count,
    /** The question is empty, too long, or does not end with a question mark. */
    invalidQuestion: count,
    /** The question contains a number, which nothing could verify (questions cite nothing). */
    numberInQuestion: count,
    /** The same question as an earlier card (case- and whitespace-insensitive). */
    duplicateQuestion: count,
    /** Beyond `QA_CARD_LIMITS.maxCards`. */
    overLimit: count,
  }),
});
export type QaRepairs = z.infer<typeof qaRepairsSchema>;

/**
 * Content of a `qa_cards` artifact. The `qa_cards` step writes revision 0; verification (P3-06)
 * writes a revision as a new artifact pointing at the one it revises, numbered by the loop that
 * wrote it. Each answer segment is stored again as a `claims` row (`segment_index = index`).
 */
export const qaCardsContentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    promptVersion: z.int().positive(),
    modelRun: reconciliationModelRunSchema,
    outputLanguage: z.string().regex(/^[a-z]{2}$/),
    tone: z.string().max(200).nullable(),
    revision: count,
    previousArtifactId: z.uuid().nullable(),
    catalog: z.array(copyCatalogEntrySchema).min(1),
    /** The code-level language check over every question and answer. */
    languageCheck: copyLanguageCheckSchema,
    cards: z.array(qaCardSchema).min(QA_CARD_LIMITS.minCards).max(QA_CARD_LIMITS.maxCards),
    repairs: qaRepairsSchema,
    counts: z.strictObject({
      catalogFacts: count,
      citedCatalogFacts: count,
      cards: count,
      segments: count,
    }),
    /**
     * The claim validator's report on the answer segments (P3-02), `variant: 'qa'` and
     * `segmentIndex` = `segment.index`. A failed segment is kept: verification revises it and
     * Gate 2 shows what remains, as for copy.
     */
    validation: claimValidationReportSchema,
  })
  .superRefine((content, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    content.cards.forEach((card, i) => {
      if (card.card !== i) issue(['cards', i, 'card'], 'Cards are numbered 0..n-1');
    });
    const segments = content.cards.flatMap((card) => card.segments);
    if (segments.some((segment, i) => segment.index !== i)) {
      issue(['cards'], 'Segment indexes must be 0..n-1 across the cards');
    }
    const catalog = new Set(content.catalog.map((entry) => entry.id));
    if (segments.some((segment) => segment.catalogIds.some((id) => !catalog.has(id)))) {
      issue(['cards'], 'A segment cites an unknown ID');
    }
    const questions = content.cards.map((card) => card.question.toLowerCase());
    if (new Set(questions).size !== questions.length) issue(['cards'], 'Questions are unique');
    if (
      content.counts.cards !== content.cards.length ||
      content.counts.segments !== segments.length
    ) {
      issue(['counts'], 'Card and segment counts');
    }
    if (
      content.validation.language !== content.outputLanguage ||
      content.validation.counts.segments !== segments.length ||
      content.validation.findings.some(
        (f) => f.variant !== QA_VARIANT || f.segmentIndex >= segments.length,
      )
    ) {
      issue(['validation'], 'The validation report must cover exactly these answer segments');
    }
    if ((content.revision === 0) !== (content.previousArtifactId === null)) {
      issue(['previousArtifactId'], 'Exactly revisions after 0 point at the artifact they revise');
    }
  });
export type QaCardsContent = z.infer<typeof qaCardsContentSchema>;
