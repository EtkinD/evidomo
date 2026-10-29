import {
  QA_CARD_LIMITS,
  type CopyLanguageCheck,
  type QaCard,
  type QaRepairs,
} from '@evidomo/shared';
import type { CopyFactCatalog } from '../creative/catalog.ts';
import { mergeUncited, type Piece } from '../creative/check.ts';
import { checkLanguage } from '../creative/language.ts';
import { isClaimLanguage, readNumbers, type ClaimLanguage } from '../claims/numbers.ts';
import type { QaDraft } from './schema.ts';

// The structural check of a Q&A answer, before anything is stored (docs/architecture.md §5,
// "Buyer Q&A cards (P3-03)"). Not the claim validator (P3-02 checks the answers' numbers against
// the cited facts afterwards). It maps catalog IDs to stored fact IDs, repairs uncited answer
// text like copy, and drops whole cards that cannot be published: a card is self-contained, so
// dropping one never changes what another says. Questions cite nothing, so a question must hold
// no number at all (nothing could verify it) and must end with a question mark.

export const QA_OUTPUT_PROBLEMS = [
  'unknown_fact_id',
  'no_cards',
  'wrong_language',
  'segment_too_long',
] as const;

/** `qaSegmentSchema.text`'s bound, checked here so a long answer is a model failure. */
const MAX_SEGMENT_LENGTH = 2000;
export type QaOutputProblem = (typeof QA_OUTPUT_PROBLEMS)[number];

/**
 * The model's answer parsed but holds no usable cards. Treated like an unparseable answer: the
 * definition's fallback runs if there is one, otherwise the engine retries the step once. The
 * message carries counts only, never model text.
 */
export class QaOutputError extends Error {
  override name = 'QaOutputError';
  readonly problem: QaOutputProblem;

  constructor(problem: QaOutputProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

export interface CheckedQa {
  readonly cards: QaCard[];
  readonly repairs: QaRepairs;
  readonly languageCheck: CopyLanguageCheck;
  /** Catalog IDs cited anywhere, in first-cited order. */
  readonly citedCatalogIds: readonly string[];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Quantity words the claim validator's number reader does not read (it reads digits, number
 * words 0–99, ordinals, `pair`, `dozen`), which still put a count into a question:
 * "one-bedroom", "both bedrooms", "a double garage", "triple glazing", "built in the sixties".
 * An explicit list, not a parser: anything else (an energy class such as "A+++", "a few",
 * "several") is left to the verifier. Matched as whole words; Dutch compounds by their start
 * ("dubbelglas", "driedubbele").
 */
const QUANTITY_WORDS: Readonly<Record<ClaimLanguage, RegExp>> = {
  en: /(?<![\p{L}\p{N}])(?:one|single|both|double|twin|triple|quadruple|once|twice|thrice|(?:twent|thirt|fort|fift|sixt|sevent|eight|ninet)ies)(?![\p{L}\p{N}])/iu,
  nl: /(?<![\p{L}\p{N}])(?:(?:één|eén|enkel|enkele|beide|beiden|eenmaal|tweemaal|driemaal)(?![\p{L}\p{N}])|(?:dubbel|driedubbel|tweeling|enkelvoudig)|jaren\s+(?:twintig|dertig|veertig|vijftig|zestig|zeventig|tachtig|negentig)(?![\p{L}\p{N}]))/iu,
};

/**
 * A tag question presumes its statement ("It has a garden, doesn't it?", "Het heeft een tuin,
 * toch?"): the statement would be published without a citation, so it is refused like a
 * malformed question.
 */
const TAG_QUESTION: Readonly<Record<ClaimLanguage, RegExp>> = {
  en: /,\s*(?:(?:is|isn['’]?t|does|doesn['’]?t|do|don['’]?t|has|hasn['’]?t|have|haven['’]?t|was|wasn['’]?t|are|aren['’]?t|can|can['’]?t|will|won['’]?t)(?:\s+(?:it|there|they|we|you))?|right|correct|true)\s*\?$/iu,
  nl: /,\s*(?:toch|niet|nietwaar|hè|he|of niet|klopt dat|juist)\s*\?$/iu,
};

/** Why a question cannot be published, or null. */
export function questionProblem(
  question: string,
  language: string,
): 'invalidQuestion' | 'numberInQuestion' | null {
  if (question === '' || question.length > QA_CARD_LIMITS.question || !question.endsWith('?')) {
    return 'invalidQuestion';
  }
  // buildQaInput refuses languages without number rules before any call.
  if (!isClaimLanguage(language)) throw new Error(`No number rules for language ${language}`);
  if (TAG_QUESTION[language].test(question)) return 'invalidQuestion';
  if (readNumbers(question, language).length > 0 || QUANTITY_WORDS[language].test(question)) {
    return 'numberInQuestion';
  }
  return null;
}

export function checkQaOutput(
  draft: QaDraft,
  catalog: CopyFactCatalog,
  language: string,
): CheckedQa {
  const dropped = {
    uncited: 0,
    invalidQuestion: 0,
    numberInQuestion: 0,
    duplicateQuestion: 0,
    overLimit: 0,
  };
  const repairs = { mergedUncited: 0, droppedEmpty: 0, droppedCards: dropped };

  let unknownIds = 0;
  const prepared = draft.cards.map((card) => ({
    question: normalize(card.question),
    pieces: card.answer.flatMap((segment): Piece[] => {
      const text = normalize(segment.text);
      if (text === '') {
        repairs.droppedEmpty += 1;
        return [];
      }
      const ids = [...new Set(segment.factIds)];
      unknownIds += ids.filter((id) => !catalog.byId.has(id)).length;
      return [{ text, ids }];
    }),
  }));
  if (unknownIds > 0) {
    throw new QaOutputError('unknown_fact_id', `The cards cite ${unknownIds} unknown fact IDs`);
  }
  // After merging uncited text below a segment can only grow, so the check runs on the merged
  // pieces; a ZodError later would fail the execution instead of counting as a model failure.
  const tooLong = (text: string) => text.length > MAX_SEGMENT_LENGTH;

  const cards: QaCard[] = [];
  const cited: string[] = [];
  const questions = new Set<string>();
  let index = 0;
  for (const { question, pieces } of prepared) {
    const { merged, mergedCount } = mergeUncited(pieces);
    if (merged.length === 0) {
      dropped.uncited += 1;
      continue;
    }
    if (merged.some((piece) => tooLong(piece.text))) {
      throw new QaOutputError(
        'segment_too_long',
        `An answer segment is longer than ${MAX_SEGMENT_LENGTH} characters`,
      );
    }
    const problem = questionProblem(question, language);
    if (problem !== null) {
      dropped[problem] += 1;
      continue;
    }
    const key = question.toLowerCase();
    if (questions.has(key)) {
      dropped.duplicateQuestion += 1;
      continue;
    }
    if (cards.length >= QA_CARD_LIMITS.maxCards) {
      dropped.overLimit += 1;
      continue;
    }
    questions.add(key);
    repairs.mergedUncited += mergedCount;
    const segments = merged.map((piece) => {
      const factIds = new Set<string>();
      for (const id of piece.ids) {
        if (!cited.includes(id)) cited.push(id);
        for (const factId of catalog.byId.get(id)?.factIds ?? []) factIds.add(factId);
      }
      const segment = {
        index,
        text: piece.text,
        catalogIds: [...piece.ids],
        factIds: [...factIds],
      };
      index += 1;
      return segment;
    });
    cards.push({ card: cards.length, question, segments });
  }
  if (cards.length < QA_CARD_LIMITS.minCards) {
    throw new QaOutputError('no_cards', `No usable card among ${draft.cards.length}`);
  }
  const text = cards
    .flatMap((card) => [card.question, ...card.segments.map((segment) => segment.text)])
    .join(' ');
  const languageCheck = checkLanguage(text, language);
  if (languageCheck === 'mismatch') {
    throw new QaOutputError('wrong_language', `The cards are not in "${language}"`);
  }
  return { cards, repairs, languageCheck, citedCatalogIds: cited };
}
