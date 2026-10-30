import type { CopyDraft, ModelSegment } from '../pipeline/creative/schema.ts';
import type { QaDraft } from '../pipeline/qa/schema.ts';
import type { Injection } from './sets.ts';

// Seeded claim defects (docs/architecture.md §12 "Seeded-defect eval"): applied to the creative
// or Q&A step's first answer as the model wrote it, before the pipeline parses, checks, stores,
// validates, and verifies it. Pure and deterministic, so a replay sends the same requests the
// recording did. Targets are chosen by catalog fact key, never by segment text, so the same
// answer key also applies to a fresh live draft.

/** A catalog fact as the copy request lists it (`copyInputSchema.facts`). */
export interface InjectionCatalogFact {
  readonly id: string;
  readonly key: string;
  readonly value: unknown;
}

export interface AppliedInjection {
  readonly id: string;
  readonly variant: Injection['variant'];
  /** Case-insensitive pattern that finds the defect in stored drafts and the export. */
  readonly marker: string;
  /** The changed or inserted segment as the pipeline received it. */
  readonly text: string;
}

export interface SkippedInjection {
  readonly id: string;
  readonly reason: 'no_target' | 'no_citable_fact' | 'no_number_in_text';
}

export interface InjectionOutcome<Draft> {
  readonly draft: Draft;
  readonly applied: readonly AppliedInjection[];
  readonly skipped: readonly SkippedInjection[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** The number as written in an English segment, standing alone (not part of another number). */
function numberPattern(value: number): string {
  return `(?<![\\d.,])${escapeRegExp(String(value))}(?![\\d]|[.,]\\d)`;
}

/** Inserts `addition` before the segment's closing punctuation (a period when there is none). */
function appendClause(text: string, addition: string): string {
  const match = /^(.*?)([.!?]*)$/su.exec(text.trimEnd());
  const body = match?.[1] ?? text;
  const end = match?.[2] === undefined || match[2] === '' ? '.' : match[2];
  return `${body}${addition}${end}`;
}

interface Located {
  /** Path into the draft's variant: segment lists in order (paragraphs or cards). */
  readonly list: number;
  readonly position: number;
  readonly segment: ModelSegment;
}

function findTarget(
  lists: readonly (readonly ModelSegment[])[],
  facts: readonly InjectionCatalogFact[],
  target: string,
): { located: Located; fact: InjectionCatalogFact } | undefined {
  const matcher = new RegExp(target, 'iu');
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  for (const [list, segments] of lists.entries()) {
    for (const [position, segment] of segments.entries()) {
      const fact = segment.factIds
        .map((id) => byId.get(id))
        .find((candidate) => candidate !== undefined && matcher.test(candidate.key));
      if (fact !== undefined) return { located: { list, position, segment }, fact };
    }
  }
  return undefined;
}

/** Applies the injections for one variant to its segment lists (copied, never mutated). */
function injectLists(
  source: readonly (readonly ModelSegment[])[],
  facts: readonly InjectionCatalogFact[],
  injections: readonly Injection[],
): { lists: ModelSegment[][]; applied: AppliedInjection[]; skipped: SkippedInjection[] } {
  const lists = source.map((segments) => segments.map((s) => ({ ...s, factIds: [...s.factIds] })));
  const applied: AppliedInjection[] = [];
  const skipped: SkippedInjection[] = [];
  for (const injection of injections) {
    const found = findTarget(lists, facts, injection.target);
    if (found === undefined) {
      skipped.push({ id: injection.id, reason: 'no_target' });
      continue;
    }
    const { located, fact } = found;
    const segments = lists[located.list];
    if (segments === undefined) throw new Error('Located a segment outside the draft');
    const replace = (text: string, marker: string): void => {
      segments[located.position] = { ...located.segment, text };
      applied.push({ id: injection.id, variant: injection.variant, marker, text });
    };
    switch (injection.op) {
      case 'append':
        replace(appendClause(located.segment.text, injection.text), injection.marker);
        break;
      case 'insert': {
        const matcher = new RegExp(injection.cite, 'iu');
        const cited = facts.find((candidate) => matcher.test(candidate.key));
        if (cited === undefined) {
          skipped.push({ id: injection.id, reason: 'no_citable_fact' });
          break;
        }
        segments.splice(located.position + 1, 0, { text: injection.text, factIds: [cited.id] });
        applied.push({
          id: injection.id,
          variant: injection.variant,
          marker: injection.marker,
          text: injection.text,
        });
        break;
      }
      case 'replace_number':
      case 'approximate': {
        if (typeof fact.value !== 'number') {
          skipped.push({ id: injection.id, reason: 'no_number_in_text' });
          break;
        }
        const written = new RegExp(numberPattern(fact.value), 'u');
        if (!written.test(located.segment.text)) {
          skipped.push({ id: injection.id, reason: 'no_number_in_text' });
          break;
        }
        if (injection.op === 'replace_number') {
          const changed = fact.value + injection.delta;
          replace(located.segment.text.replace(written, String(changed)), numberPattern(changed));
        } else {
          replace(
            located.segment.text.replace(written, `${injection.prefix} ${String(fact.value)}`),
            `${escapeRegExp(injection.prefix)} ${numberPattern(fact.value)}`,
          );
        }
        break;
      }
      default: {
        const unreachable: never = injection;
        throw new Error(`Unknown injection ${JSON.stringify(unreachable)}`);
      }
    }
  }
  return { lists, applied, skipped };
}

/** The copy draft with the portal and social injections applied, in answer-key order. */
export function injectCopyDraft(
  draft: CopyDraft,
  facts: readonly InjectionCatalogFact[],
  injections: readonly Injection[],
): InjectionOutcome<CopyDraft> {
  const portal = injectLists(
    draft.portal.paragraphs.map((p) => p.segments),
    facts,
    injections.filter((i) => i.variant === 'portal'),
  );
  const social = injectLists(
    [draft.social.segments],
    facts,
    injections.filter((i) => i.variant === 'social'),
  );
  return {
    draft: {
      portal: { paragraphs: portal.lists.map((segments) => ({ segments })) },
      social: { segments: social.lists[0] ?? [] },
    },
    applied: [...portal.applied, ...social.applied],
    skipped: [...portal.skipped, ...social.skipped],
  };
}

/** The Q&A cards with the `qa` injections applied (answers only; questions stay). */
export function injectQaDraft(
  draft: QaDraft,
  facts: readonly InjectionCatalogFact[],
  injections: readonly Injection[],
): InjectionOutcome<QaDraft> {
  const result = injectLists(
    draft.cards.map((card) => card.answer),
    facts,
    injections.filter((i) => i.variant === 'qa'),
  );
  return {
    draft: {
      cards: draft.cards.map((card, i) => ({
        question: card.question,
        answer: result.lists[i] ?? card.answer,
      })),
    },
    applied: result.applied,
    skipped: result.skipped,
  };
}
