import type { PhotoQualityRating } from '@evidomo/shared';

// Deterministic choices across the run's photos: which observations get a SAM evidence request
// within `max_evidence_masks`, which evidence instances keep their mask, and the cover ranking.

export interface EvidenceCandidate {
  readonly photoIndex: number;
  readonly key: string;
  readonly phrase: string;
  /** Position of the object in the market's evidence list (lower = more important). */
  readonly priority: number;
  readonly quality: PhotoQualityRating;
}

const QUALITY_ORDER: Readonly<Record<PhotoQualityRating, number>> = {
  good: 0,
  acceptable: 1,
  poor: 2,
};

/**
 * Picks at most `cap` (photo, object) requests. Breadth first: one request for every distinct
 * object (in market priority order) before a second photo of any object, so a 12-request cap
 * covers 12 different objects when the photos show that many. Within an object, better-quality
 * photos come first, then upload order.
 */
export function selectEvidenceRequests(
  candidates: readonly EvidenceCandidate[],
  cap: number,
): EvidenceCandidate[] {
  const byObject = new Map<number, EvidenceCandidate[]>();
  for (const candidate of candidates) {
    const group = byObject.get(candidate.priority) ?? [];
    group.push(candidate);
    byObject.set(candidate.priority, group);
  }
  const groups = [...byObject.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) =>
      [...group].sort(
        (a, b) =>
          QUALITY_ORDER[a.quality] - QUALITY_ORDER[b.quality] || a.photoIndex - b.photoIndex,
      ),
    );
  const selected: EvidenceCandidate[] = [];
  for (let round = 0; selected.length < cap; round += 1) {
    let added = false;
    for (const group of groups) {
      const next = group[round];
      if (next === undefined) continue;
      added = true;
      selected.push(next);
      if (selected.length >= cap) break;
    }
    if (!added) break;
  }
  return selected;
}

/**
 * Which evidence instances keep their mask, at most `cap` in total. Every request first keeps its
 * highest-scoring instance (requests never exceed the cap, so each answered request gets one),
 * then the remaining budget goes to further instances in request order, best score first.
 * `scores[r]` lists request r's instance scores; the result holds `"<request>:<instance>"`.
 */
export function allocateEvidenceMasks(
  scores: readonly (readonly (number | undefined)[])[],
  cap: number,
): Set<string> {
  const ranked = scores.map((list) =>
    list
      .map((score, index) => ({ index, score: score ?? 0 }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.index),
  );
  const kept = new Set<string>();
  for (const [request, order] of ranked.entries()) {
    const best = order[0];
    if (best !== undefined && kept.size < cap) kept.add(`${request}:${best}`);
  }
  for (const [request, order] of ranked.entries()) {
    for (const index of order.slice(1)) {
      if (kept.size >= cap) return kept;
      kept.add(`${request}:${index}`);
    }
  }
  return kept;
}

export interface CoverCandidate {
  readonly photoIndex: number;
  readonly coverScore: number;
  readonly quality: PhotoQualityRating;
  readonly issueCount: number;
}

/**
 * Cover ranks (1 = best) for classified photos: higher cover score, then better quality, then
 * fewer quality issues, then upload order. Returns photo index → rank.
 */
export function rankCovers(candidates: readonly CoverCandidate[]): Map<number, number> {
  const ordered = [...candidates].sort(
    (a, b) =>
      b.coverScore - a.coverScore ||
      QUALITY_ORDER[a.quality] - QUALITY_ORDER[b.quality] ||
      a.issueCount - b.issueCount ||
      a.photoIndex - b.photoIndex,
  );
  return new Map(ordered.map((candidate, index) => [candidate.photoIndex, index + 1]));
}
