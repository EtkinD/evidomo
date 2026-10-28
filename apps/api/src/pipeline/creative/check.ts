import {
  COPY_VARIANTS,
  type CopyRepairs,
  type CopyVariant,
  type CopyVariantKind,
} from '@evidomo/shared';
import type { CopyFactCatalog } from './catalog.ts';
import { checkLanguage } from './language.ts';
import type { CopyDraft, ModelSegment } from './schema.ts';

// The structural check of a copy answer, before any segment is stored (docs/architecture.md §5
// Creative). It is not the claim validator (P3-02 checks numbers against the cited facts); it
// makes sure every segment cites only known facts, maps catalog IDs to stored fact IDs, applies
// the documented repairs for uncited text, and rejects copy in the wrong language.

export const COPY_OUTPUT_PROBLEMS = ['unknown_fact_id', 'empty_variant', 'wrong_language'] as const;
export type CopyOutputProblem = (typeof COPY_OUTPUT_PROBLEMS)[number];

/**
 * The model's answer parsed but is not usable copy. Treated like an unparseable answer: the
 * definition's fallback runs if there is one, otherwise the engine retries the step once. The
 * message carries counts and variant names only, never model text.
 */
export class CopyOutputError extends Error {
  override name = 'CopyOutputError';
  readonly problem: CopyOutputProblem;

  constructor(problem: CopyOutputProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

export interface CheckedCopy {
  /** `portal`, then `social`; segment indexes run across both. */
  readonly variants: CopyVariant[];
  readonly repairs: CopyRepairs;
  /** Catalog IDs cited anywhere, in first-cited order. */
  readonly citedCatalogIds: readonly string[];
}

interface Piece {
  readonly text: string;
  readonly ids: readonly string[];
}

function paragraphsOf(draft: CopyDraft, kind: CopyVariantKind): ModelSegment[][] {
  switch (kind) {
    case 'portal':
      return draft.portal.paragraphs.map((paragraph) => paragraph.segments);
    case 'social':
      return [draft.social.segments];
    default: {
      const unreachable: never = kind;
      throw new Error(`Unknown copy variant ${String(unreachable)}`);
    }
  }
}

/**
 * Uncited text (connectives, a stray stylistic sentence) is joined to the next cited segment of
 * its paragraph, or to the previous one at the paragraph's end, so it is checked together with
 * the claim it leads into; a paragraph that cites nothing at all is dropped.
 */
function mergeUncited(pieces: readonly Piece[]): { merged: Piece[]; mergedCount: number } {
  const merged: Piece[] = [];
  let pending: string[] = [];
  let mergedCount = 0;
  for (const piece of pieces) {
    if (piece.ids.length === 0) {
      pending.push(piece.text);
      mergedCount += 1;
      continue;
    }
    merged.push({ text: [...pending, piece.text].join(' '), ids: piece.ids });
    pending = [];
  }
  const last = merged.at(-1);
  if (pending.length > 0 && last !== undefined) {
    merged[merged.length - 1] = { text: [last.text, ...pending].join(' '), ids: last.ids };
  }
  return { merged, mergedCount };
}

export function checkCopyOutput(
  draft: CopyDraft,
  catalog: CopyFactCatalog,
  language: string,
): CheckedCopy {
  const repairs = { mergedUncited: 0, droppedUncitedParagraphs: 0, droppedEmpty: 0 };
  let unknownIds = 0;
  const prepared = COPY_VARIANTS.map((kind) => ({
    kind,
    paragraphs: paragraphsOf(draft, kind).map((segments) =>
      segments.flatMap((segment): Piece[] => {
        const text = segment.text.replace(/\s+/g, ' ').trim();
        if (text === '') {
          repairs.droppedEmpty += 1;
          return [];
        }
        const ids = [...new Set(segment.factIds)];
        unknownIds += ids.filter((id) => !catalog.byId.has(id)).length;
        return [{ text, ids }];
      }),
    ),
  }));
  if (unknownIds > 0) {
    throw new CopyOutputError('unknown_fact_id', `The copy cites ${unknownIds} unknown fact IDs`);
  }

  const variants: CopyVariant[] = [];
  const cited: string[] = [];
  let index = 0;
  for (const { kind, paragraphs } of prepared) {
    const segments: CopyVariant['segments'] = [];
    let paragraph = 0;
    for (const pieces of paragraphs) {
      if (pieces.length === 0) continue;
      const { merged, mergedCount } = mergeUncited(pieces);
      if (merged.length === 0) {
        repairs.droppedUncitedParagraphs += 1;
        continue;
      }
      repairs.mergedUncited += mergedCount;
      for (const piece of merged) {
        const factIds = new Set<string>();
        for (const id of piece.ids) {
          if (!cited.includes(id)) cited.push(id);
          for (const factId of catalog.byId.get(id)?.factIds ?? []) factIds.add(factId);
        }
        segments.push({
          index,
          paragraph,
          text: piece.text,
          catalogIds: [...piece.ids],
          factIds: [...factIds],
        });
        index += 1;
      }
      paragraph += 1;
    }
    if (segments.length === 0) {
      throw new CopyOutputError('empty_variant', `The ${kind} copy has no cited segment`);
    }
    const languageCheck = checkLanguage(segments.map((s) => s.text).join(' '), language);
    if (languageCheck === 'mismatch') {
      throw new CopyOutputError('wrong_language', `The ${kind} copy is not in "${language}"`);
    }
    variants.push({ kind, languageCheck, segments });
  }
  return { variants, repairs, citedCatalogIds: cited };
}
