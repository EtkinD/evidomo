import {
  CLAIM_VALIDATOR_RULES_VERSION,
  claimValidationReportSchema,
  type ClaimFinding,
  type ClaimFindingCode,
  type ClaimValidationReport,
  type FactAssertion,
  type FactSourceKind,
  type FactStatus,
  type JsonValue,
} from '@evidomo/shared';
import {
  canonicalUnit,
  readNumbers,
  unitOfKey,
  type ClaimLanguage,
  type NumberToken,
} from './numbers.ts';

// The code-level claim validator (docs/architecture.md §6 step 2, §5 "Claim validator (P3-02)"):
// a pure function over segments and the run's facts. It rejects a segment that cites nothing,
// cites an ID that is not a verified, stated fact of the run, or contains a number that no cited
// fact states exactly (same value, compatible unit, no approximation or range). It runs before
// any model-based verification and knows nothing about the step that wrote the segments, so the
// creative step, verification's revisions (P3-06), and Q&A cards (P3-03) call it the same way.

/** One claim to check: a sentence or clause and the stored fact IDs it cites. */
export interface ClaimSegment {
  /** The caller's grouping (`portal`, `social`, `qa`, ...): lowercase, `[a-z0-9_]`. */
  readonly variant: string;
  readonly segmentIndex: number;
  readonly text: string;
  /** Fact IDs exactly as cited (unknown or malformed IDs are reported, not dropped). */
  readonly factIds: readonly string[];
}

/** The part of a stored fact the validator reads (a `Fact` row satisfies it). */
export interface ClaimFact {
  readonly id: string;
  readonly key: string;
  readonly value: JsonValue;
  readonly unit: string | null;
  readonly status: FactStatus;
  readonly assertion: FactAssertion;
  readonly source: { readonly kind: FactSourceKind };
}

export interface ClaimValidationInput {
  /** The segments' language: numbers and number words are read with its rules. */
  readonly language: ClaimLanguage;
  readonly segments: readonly ClaimSegment[];
  /**
   * The run's facts: all of them, or only the verified ones (a cited fact that is missing is
   * `unknown_fact_id`, a present one that is not verified is `unverified_fact`).
   */
  readonly facts: readonly ClaimFact[];
}

const MAX_TOKEN = 60;
const MAX_FACT_ID = 64;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A value a cited fact states, with its canonical unit (null: the fact has none). */
interface StatedNumber {
  readonly value: number;
  readonly unit: string | null;
  /** The unit as the fact writes it, for the finding's sentence. */
  readonly unitLabel: string | null;
  readonly factId: string;
}

interface CitedEvidence {
  readonly numbers: readonly StatedNumber[];
  /** Text values of cited stated facts (dates and times must appear in one of them). */
  readonly texts: readonly string[];
  /** The segment cites at least one photo fact (presence evidence only). */
  readonly citesPhoto: boolean;
}

function factUnit(fact: ClaimFact): { unit: string | null; label: string | null } {
  if (fact.unit !== null) return { unit: canonicalUnit(fact.unit), label: fact.unit };
  const fromKey = unitOfKey(fact.key);
  return { unit: fromKey, label: fromKey };
}

/**
 * The numbers and texts the valid cited facts state. Photo facts contribute nothing: their
 * stored value is an instance count in one photo, never a property total. Booleans state no
 * number. A text value contributes the numbers in it, read in the segment's language.
 */
function citedEvidence(facts: readonly ClaimFact[], language: ClaimLanguage): CitedEvidence {
  const numbers: StatedNumber[] = [];
  const texts: string[] = [];
  let citesPhoto = false;
  for (const fact of facts) {
    if (fact.source.kind === 'photo_region') {
      citesPhoto = true;
      continue;
    }
    const { unit, label } = factUnit(fact);
    if (typeof fact.value === 'number') {
      numbers.push({ value: fact.value, unit, unitLabel: label, factId: fact.id });
    } else if (typeof fact.value === 'string') {
      texts.push(fact.value);
      for (const token of readNumbers(fact.value, language)) {
        if (token.reading.kind !== 'value') continue;
        const ownUnit = token.reading.unit;
        numbers.push({
          value: token.reading.value,
          unit: ownUnit ?? unit,
          unitLabel: ownUnit ?? label,
          factId: fact.id,
        });
      }
    }
  }
  return { numbers, texts, citesPhoto };
}

type Problem = Omit<ClaimFinding, 'variant' | 'segmentIndex'>;

function citationProblems(
  segment: ClaimSegment,
  factsById: ReadonlyMap<string, ClaimFact>,
): { problems: Problem[]; valid: ClaimFact[] } {
  if (segment.factIds.length === 0) {
    return {
      problems: [
        {
          code: 'missing_fact_ids',
          token: null,
          factId: null,
          detail: 'The segment cites no fact.',
        },
      ],
      valid: [],
    };
  }
  const problems: Problem[] = [];
  const valid: ClaimFact[] = [];
  for (const id of new Set(segment.factIds)) {
    const factId = id === '' ? null : clip(id, MAX_FACT_ID);
    const fact = factsById.get(id);
    if (fact === undefined) {
      problems.push({
        code: 'unknown_fact_id',
        token: null,
        factId,
        detail: 'The segment cites a fact that is not part of this run.',
      });
    } else if (fact.assertion === 'opinion') {
      problems.push({
        code: 'opinion_cited',
        token: null,
        factId,
        detail: 'The segment cites an opinion, which is never a valid source.',
      });
    } else if (fact.status !== 'verified') {
      problems.push({
        code: 'unverified_fact',
        token: null,
        factId,
        detail: `The segment cites a fact that is not verified (${fact.status}).`,
      });
    } else {
      valid.push(fact);
    }
  }
  return { problems, valid };
}

function numberProblems(
  text: string,
  token: NumberToken,
  evidence: CitedEvidence,
  language: ClaimLanguage,
): Problem[] {
  const quote = (from: number, to: number): string =>
    clip(text.slice(from, to).replace(/\s+/g, ' ').trim(), MAX_TOKEN);
  const span = quote(token.start, token.end);
  const problems: Problem[] = [];
  const problem = (code: ClaimFindingCode, detail: string, factId: string | null = null): void => {
    problems.push({ code, token: span, factId, detail });
  };

  const { reading } = token;
  switch (reading.kind) {
    case 'unreadable':
      problem(
        'unreadable_number',
        `"${span}" cannot be read as one exact number in "${language}"; write the exact value in digits.`,
      );
      break;
    case 'datetime':
      if (!evidence.texts.some((value) => value.includes(span))) {
        problem('number_not_in_facts', `"${span}" is not stated by any cited fact.`);
      }
      break;
    case 'value': {
      const equal = evidence.numbers.filter((stated) => stated.value === reading.value);
      if (equal.length === 0) {
        if (evidence.citesPhoto) {
          problem(
            'number_from_photo',
            `"${span}" is not stated by any cited fact; photo facts show presence only, never a count or measurement.`,
          );
        } else {
          problem('number_not_in_facts', `"${span}" is not stated by any cited fact.`);
        }
      } else if (reading.unit !== null && !equal.some((stated) => stated.unit === reading.unit)) {
        const [first] = equal;
        const units = [...new Set(equal.map((stated) => stated.unitLabel ?? 'no unit'))];
        problem(
          'unit_mismatch',
          `"${span}": the unit does not match the cited fact (${units.join(', ')}).`,
          first === undefined ? null : clip(first.factId, MAX_FACT_ID),
        );
      }
      break;
    }
    default: {
      const unreachable: never = reading;
      throw new Error(`Unknown number reading ${JSON.stringify(unreachable)}`);
    }
  }

  if (token.approximateFrom !== null || token.approximateSuffix) {
    problems.push({
      code: 'approximate_number',
      token: quote(token.approximateFrom ?? token.start, token.end),
      factId: null,
      detail: `"${quote(token.approximateFrom ?? token.start, token.end)}" is approximate; the facts state an exact value.`,
    });
  }
  if (token.rangeTo !== null) {
    const range = quote(token.start, token.rangeTo);
    problems.push({
      code: 'number_range',
      token: range,
      factId: null,
      detail: `"${range}" is a range; the facts state an exact value.`,
    });
  }
  return problems;
}

/**
 * Validates every segment and returns the typed report: findings per segment (stable codes,
 * the offending number token, never the segment text), and `pass` only when there are none.
 */
export function validateClaims(input: ClaimValidationInput): ClaimValidationReport {
  const { language, segments } = input;
  const factsById = new Map(input.facts.map((fact) => [fact.id, fact]));
  const findings: ClaimFinding[] = [];
  const failed = new Set<string>();
  let numbers = 0;

  for (const segment of segments) {
    const { problems, valid } = citationProblems(segment, factsById);
    const evidence = citedEvidence(valid, language);
    const tokens = readNumbers(segment.text, language);
    numbers += tokens.length;
    for (const token of tokens) {
      problems.push(...numberProblems(segment.text, token, evidence, language));
    }
    // The same token repeated ("2021 ... 2021") reads as one problem.
    const seen = new Set<string>();
    for (const problem of problems) {
      const key = JSON.stringify([problem.code, problem.token, problem.factId]);
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ variant: segment.variant, segmentIndex: segment.segmentIndex, ...problem });
      failed.add(`${segment.variant}\u0000${segment.segmentIndex}`);
    }
  }

  return claimValidationReportSchema.parse({
    rulesVersion: CLAIM_VALIDATOR_RULES_VERSION,
    language,
    result: findings.length === 0 ? 'pass' : 'fail',
    counts: {
      segments: segments.length,
      failedSegments: failed.size,
      numbers,
      findings: findings.length,
    },
    findings,
  } satisfies ClaimValidationReport);
}

/** The findings of one segment, for `claims.validator_details` and per-segment display. */
export function findingsForSegment(
  report: ClaimValidationReport,
  variant: string,
  segmentIndex: number,
): ClaimFinding[] {
  return report.findings.filter(
    (finding) => finding.variant === variant && finding.segmentIndex === segmentIndex,
  );
}
