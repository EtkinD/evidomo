import type {
  FactAssertion,
  MarketFact,
  MarketProfile,
  StoredTranscriptTurn,
} from '@evidomo/shared';
import {
  OTHER_KEY,
  OTHER_KEY_PREFIX,
  OTHER_SLUG_PATTERN,
  REPORT_TEXT_LIMIT,
  UNSPECIFIED_BASIS,
  marketUnits,
  type ExtractionRejectionReason,
  type FactValue,
  type RawExtractedFact,
  type TranscriptCandidate,
} from './schema.ts';

// Deterministic validation and repair of the model's facts (docs/architecture.md §5 step 2).
// Nothing the model says about keys, units, bases, or quotes is trusted: P1-03 showed every
// model filing a basis-less gross area under a new free-text key each time. Repairs only ever
// move a fact toward less precision (a bare key into `other:`, a missing basis to
// `unspecified`), never toward a core profile fact.

// ---------------------------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------------------------

interface Folded {
  readonly text: string;
  /** For each UTF-16 unit of `text`: start and end offsets of its source character. */
  readonly from: readonly number[];
  readonly to: readonly number[];
}

const WHITESPACE = /\s/u;

/** Lower case with whitespace runs collapsed to one space, keeping a map to the source. */
function fold(source: string): Folded {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let inSpace = false;
  for (let i = 0; i < source.length;) {
    const codePoint = source.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(codePoint);
    const end = i + char.length;
    if (WHITESPACE.test(char)) {
      if (!inSpace) {
        text += ' ';
        from.push(i);
        to.push(end);
      }
      inSpace = true;
    } else {
      inSpace = false;
      // Lower-casing can change the length (e.g. "İ"); every produced unit maps to the source.
      for (const unit of char.toLowerCase()) {
        for (let k = 0; k < unit.length; k += 1) {
          text += unit[k] ?? '';
          from.push(i);
          to.push(end);
        }
      }
    }
    i = end;
  }
  return { text, from, to };
}

/** Whitespace and case normalization, the only differences a quote may have from its turn. */
export function normalizeQuote(quote: string): string {
  return fold(quote).text.trim();
}

/**
 * The exact span of `text` that equals `quote` up to whitespace and case, or `undefined`. The
 * stored quote is this span, so `turn.text.includes(quote)` holds afterwards (the
 * reconciliation catalog checks exactly that).
 */
export function findQuoteSpan(text: string, quote: string): string | undefined {
  const needle = normalizeQuote(quote);
  if (needle.length === 0) return undefined;
  const haystack = fold(text);
  const at = haystack.text.indexOf(needle);
  if (at < 0) return undefined;
  const start = haystack.from[at];
  const end = haystack.to[at + needle.length - 1];
  if (start === undefined || end === undefined) return undefined;
  return text.slice(start, end);
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** `Balcony area (m2)` → `balcony_area_m2`; accents dropped, anything else becomes `_`. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export interface ResolvedKey {
  readonly key: string;
  /** The market fact, for profile keys; `undefined` for `other:` keys. */
  readonly fact: MarketFact | undefined;
  readonly repaired: boolean;
}

/**
 * A profile key only when the model chose exactly that key from the enum. Anything else lands
 * in `other:<slug>`: a misspelled or invented key is never promoted to a core fact, even when
 * it resembles one, because a wrong core key is what lets a gross area pass as living area.
 */
export function resolveKey(
  market: MarketProfile,
  key: string,
  otherKey: string | null,
): ResolvedKey | undefined {
  const fact = market.facts.find((candidate) => candidate.key === key);
  if (fact !== undefined) return { key, fact, repaired: false };

  let name: string;
  let repaired: boolean;
  if (key === OTHER_KEY) {
    name = otherKey ?? '';
    repaired = false;
  } else if (key.startsWith(OTHER_KEY_PREFIX)) {
    name = key.slice(OTHER_KEY_PREFIX.length);
    repaired = true;
  } else {
    name = key;
    repaired = true;
  }
  const slug = slugify(name);
  if (!OTHER_SLUG_PATTERN.test(slug)) return undefined;
  return {
    key: `${OTHER_KEY_PREFIX}${slug}`,
    fact: undefined,
    repaired: repaired || slug !== name,
  };
}

// ---------------------------------------------------------------------------------------------
// Values, units, bases
// ---------------------------------------------------------------------------------------------

/** The unit a profile fact always carries (from the profile, never from the model). */
export function profileUnit(market: MarketProfile, fact: MarketFact): string | null {
  switch (fact.type) {
    case 'area':
      return market.units.area;
    case 'volume':
      return market.units.volume ?? null;
    case 'money':
      return market.currency ?? null;
    case 'enum':
    case 'integer':
    case 'boolean':
      return null;
  }
}

/** Whether a value is valid for a profile fact exactly as given (the fact form's rule). */
export function isValidProfileValue(fact: MarketFact, value: unknown): value is FactValue {
  return checkProfileValue(fact, value);
}

function checkProfileValue(fact: MarketFact, value: unknown): boolean {
  switch (fact.type) {
    case 'enum':
      return typeof value === 'string' && fact.values.includes(value);
    case 'area':
    case 'volume':
    case 'money':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        (fact.min === undefined || value >= fact.min) &&
        (fact.max === undefined || value <= fact.max)
      );
    case 'boolean':
      return typeof value === 'boolean';
  }
}

const PLAIN_NUMBER = /^\d+(?:\.\d+)?$/;
const BOOLEAN_WORDS: Readonly<Record<string, boolean>> = {
  true: true,
  yes: true,
  false: false,
  no: false,
};

interface Repairable<T> {
  readonly value: T;
  readonly repaired: boolean;
}

/**
 * A model value for a profile fact: valid as is, or repaired by an unambiguous conversion
 * (enum case, a plain digit string for a number, "yes"/"no" for a boolean). Anything else is
 * invalid; nothing is parsed from prose.
 */
export function coerceProfileValue(
  fact: MarketFact,
  value: FactValue,
): Repairable<FactValue> | undefined {
  if (checkProfileValue(fact, value)) return { value, repaired: false };
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  let candidate: FactValue | undefined;
  switch (fact.type) {
    case 'enum':
      candidate = fact.values.find((option) => option.toLowerCase() === text.toLowerCase());
      break;
    case 'area':
    case 'volume':
    case 'money':
    case 'integer':
      candidate = PLAIN_NUMBER.test(text) ? Number(text) : undefined;
      break;
    case 'boolean':
      candidate = BOOLEAN_WORDS[text.toLowerCase()];
      break;
  }
  return candidate !== undefined && isValidProfileValue(fact, candidate)
    ? { value: candidate, repaired: true }
    : undefined;
}

/** Values of `other:` facts: a finite number, a boolean, or non-empty bounded text. */
function coerceOtherValue(value: FactValue): FactValue | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  const text = value.trim();
  return text.length > 0 && text.length <= REPORT_TEXT_LIMIT ? text : undefined;
}

/**
 * The basis of a fact with this unit: areas take a profile basis or `unspecified` (a missing or
 * unknown basis becomes `unspecified`, never a guess); every other fact has none.
 */
function resolveBasis(
  market: MarketProfile,
  unit: string | null,
  basis: string | null,
): Repairable<string | null> {
  if (unit !== market.units.area) return { value: null, repaired: basis !== null };
  const known =
    basis === UNSPECIFIED_BASIS || market.area_bases.some((candidate) => candidate.id === basis);
  return known && basis !== null
    ? { value: basis, repaired: false }
    : { value: UNSPECIFIED_BASIS, repaired: true };
}

// ---------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------

export interface RejectedFact {
  readonly reason: ExtractionRejectionReason;
  readonly turnIndex: number;
  readonly key: string;
  readonly quote: string;
}

export interface NormalizedExtraction {
  readonly accepted: TranscriptCandidate[];
  readonly rejected: RejectedFact[];
}

type Outcome =
  | { readonly ok: true; readonly fact: TranscriptCandidate }
  | { readonly ok: false; readonly reason: ExtractionRejectionReason };

function normalizeOne(
  market: MarketProfile,
  turns: readonly StoredTranscriptTurn[],
  raw: RawExtractedFact,
): Outcome {
  const turn = Number.isSafeInteger(raw.turnIndex) ? turns[raw.turnIndex] : undefined;
  if (turn?.index !== raw.turnIndex) return { ok: false, reason: 'unknown_turn' };
  const quote = findQuoteSpan(turn.text, raw.quote);
  if (quote === undefined) return { ok: false, reason: 'quote_mismatch' };

  const resolved = resolveKey(market, raw.key, raw.otherKey);
  if (resolved === undefined) return { ok: false, reason: 'invalid_key' };

  let value: FactValue;
  let unit: string | null;
  let repaired = resolved.repaired;
  if (resolved.fact !== undefined) {
    const coerced = coerceProfileValue(resolved.fact, raw.value);
    if (coerced === undefined) return { ok: false, reason: 'invalid_value' };
    value = coerced.value;
    repaired ||= coerced.repaired;
    // The profile decides the unit. A different unit from the model means it thought of
    // another quantity (a volume filed as an area), so the fact is not repaired but dropped.
    unit = profileUnit(market, resolved.fact);
    if (raw.unit !== null && raw.unit !== unit) return { ok: false, reason: 'unit_mismatch' };
    repaired ||= raw.unit !== unit;
  } else {
    const coerced = coerceOtherValue(raw.value);
    if (coerced === undefined) return { ok: false, reason: 'invalid_value' };
    value = coerced;
    if (raw.unit !== null && !marketUnits(market).includes(raw.unit)) {
      return { ok: false, reason: 'unit_mismatch' };
    }
    unit = raw.unit;
  }
  const basis = resolveBasis(market, unit, raw.basis);
  repaired ||= basis.repaired;

  // Anything but an explicit "stated" is treated as an opinion: the safe direction.
  const assertion: FactAssertion = raw.assertion === 'stated' ? 'stated' : 'opinion';
  repaired ||= raw.assertion !== 'stated' && raw.assertion !== 'opinion';

  return {
    ok: true,
    fact: {
      key: resolved.key,
      value,
      unit,
      basis: basis.value,
      assertion,
      turnIndex: turn.index,
      startMs: turn.startMs,
      endMs: turn.endMs,
      quote,
      repaired,
    },
  };
}

function clip(text: string): string {
  return text.length <= REPORT_TEXT_LIMIT ? text : text.slice(0, REPORT_TEXT_LIMIT);
}

/**
 * Validates and repairs the model's facts against the transcript and the market profile. A
 * fact is dropped when its turn does not exist, its quote is not in that turn (up to whitespace
 * and case), its key cannot be made a valid `other:` slug, its value does not fit the fact, or
 * its unit contradicts the profile. Exact repeats (same key, value, unit, basis, assertion, and
 * turn) are dropped as duplicates; the same value in two turns is kept twice.
 */
export function normalizeExtractedFacts(
  market: MarketProfile,
  turns: readonly StoredTranscriptTurn[],
  raw: readonly RawExtractedFact[],
): NormalizedExtraction {
  const accepted: TranscriptCandidate[] = [];
  const rejected: RejectedFact[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const outcome = normalizeOne(market, turns, item);
    const reject = (reason: ExtractionRejectionReason): void => {
      rejected.push({
        reason,
        turnIndex: item.turnIndex,
        key: clip(item.key === OTHER_KEY ? `${OTHER_KEY}:${item.otherKey ?? ''}` : item.key),
        quote: clip(item.quote),
      });
    };
    if (!outcome.ok) {
      reject(outcome.reason);
      continue;
    }
    const { fact } = outcome;
    const identity = JSON.stringify([
      fact.key,
      fact.value,
      fact.unit,
      fact.basis,
      fact.assertion,
      fact.turnIndex,
    ]);
    if (seen.has(identity)) {
      reject('duplicate');
      continue;
    }
    seen.add(identity);
    accepted.push(fact);
  }
  return { accepted, rejected };
}
