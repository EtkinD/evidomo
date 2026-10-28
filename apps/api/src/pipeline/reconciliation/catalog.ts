import {
  reconciledValueSchema,
  type FactAssertion,
  type FactSourceKind,
  type MarketProfile,
  type PhotoInventoryContent,
  type ReconciledValue,
  type StoredTranscriptTurn,
} from '@evidomo/shared';
import type { Fact } from '../../db/repositories/facts.ts';
import { profileUnit } from '../extraction/normalize.ts';
import type { Measured } from './compare.ts';
import { reconciliationInputSchema, type ReconciliationInput } from './schema.ts';

// The evidence catalog for one run (docs/architecture.md §5 step 4): the run's candidate facts
// under short evidence IDs (`F.<field>`, `Cnn`, `Pnn.Rk`), which are all the model ever cites.
// Code maps every ID back to its stored fact, so provenance never passes through the model.
// The catalog order is derived from the content, never from database IDs or insertion times,
// so the same candidates always produce the same request (and fixture hash).

/** A candidate fact with its catalog ID. */
export interface CatalogFact extends Measured {
  readonly fact: Fact;
  readonly evidenceId: string;
  readonly sourceKind: FactSourceKind;
  readonly assertion: FactAssertion;
}

export interface Catalog {
  /** What the model receives (opinions are left out: code rejects them, they cannot conflict). */
  readonly input: ReconciliationInput;
  /** Every candidate fact the step read, opinions included, in catalog order. */
  readonly items: readonly CatalogFact[];
  /** The IDs the model was shown. */
  readonly sent: ReadonlyMap<string, CatalogFact>;
}

/** The catalog cannot be built from the stored data; a retry would fail the same way. */
export class CatalogError extends Error {
  override name = 'CatalogError';
}

export interface CatalogSources {
  readonly market: MarketProfile;
  /** The run's candidate facts. */
  readonly facts: readonly Fact[];
  /** The intake transcript; required when any fact cites a transcript turn. */
  readonly transcript: {
    readonly artifactId: string;
    readonly turns: readonly StoredTranscriptTurn[];
  } | null;
  /** The vision inventory; required when any fact cites a photo region. */
  readonly inventory: PhotoInventoryContent | null;
}

const MAX_CATALOG_INDEX = 999;

function sequenceId(prefix: string, index: number): string {
  if (index > MAX_CATALOG_INDEX) {
    throw new CatalogError(`The run has more than ${MAX_CATALOG_INDEX} items of one evidence kind`);
  }
  return `${prefix}${String(index).padStart(2, '0')}`;
}

export const turnEvidenceId = (turnIndex: number): string => sequenceId('T', turnIndex);

function scalar(fact: Fact): ReconciledValue {
  const parsed = reconciledValueSchema.safeParse(fact.value);
  if (!parsed.success) throw new CatalogError('A candidate fact has a non-scalar value');
  return parsed.data;
}

function catalogFact(fact: Fact, evidenceId: string): CatalogFact {
  return {
    fact,
    evidenceId,
    key: fact.key,
    value: scalar(fact),
    unit: fact.unit,
    basis: fact.basis,
    sourceKind: fact.source.kind,
    assertion: fact.assertion,
  };
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Transcript facts in spoken order: turn, position of the quote in the turn, then content.
 * P2-07 drops exact repeats within a turn, so the order is total.
 */
function transcriptOrder(turns: readonly StoredTranscriptTurn[]) {
  const position = (fact: Fact): [number, number] => {
    if (fact.source.kind !== 'transcript_turn') return [0, 0];
    const turn = turns[fact.source.turnIndex];
    return [fact.source.turnIndex, turn?.text.indexOf(fact.source.quote) ?? -1];
  };
  const quote = (fact: Fact): string =>
    fact.source.kind === 'transcript_turn' ? fact.source.quote : '';
  return (a: Fact, b: Fact): number => {
    const [turnA, offsetA] = position(a);
    const [turnB, offsetB] = position(b);
    return (
      turnA - turnB ||
      offsetA - offsetB ||
      compareText(a.key, b.key) ||
      compareText(quote(a), quote(b)) ||
      compareText(JSON.stringify(a.value), JSON.stringify(b.value)) ||
      compareText(a.unit ?? '', b.unit ?? '') ||
      compareText(a.basis ?? '', b.basis ?? '') ||
      compareText(a.assertion, b.assertion)
    );
  };
}

export function buildCatalog(sources: CatalogSources): Catalog {
  const { market, facts } = sources;
  const formFacts: Fact[] = [];
  const spokenFacts: Fact[] = [];
  const photoFacts: Fact[] = [];
  for (const fact of facts) {
    switch (fact.source.kind) {
      case 'form':
        formFacts.push(fact);
        break;
      case 'transcript_turn':
        spokenFacts.push(fact);
        break;
      case 'photo_region':
        photoFacts.push(fact);
        break;
      default: {
        const unreachable: never = fact.source;
        throw new CatalogError(`Unknown fact source ${JSON.stringify(unreachable)}`);
      }
    }
  }
  if (formFacts.length === 0) throw new CatalogError('The run has no fact form candidates');

  // Form: one fact per field (the form is a flat object), in field order.
  const form = formFacts
    .map((fact) => {
      if (fact.source.kind !== 'form') throw new CatalogError('Unexpected fact source');
      return catalogFact(fact, `F.${fact.source.field}`);
    })
    .sort((a, b) => compareText(a.evidenceId, b.evidenceId));

  // Transcript candidates cite the run's single transcript.
  const transcript = sources.transcript;
  if (spokenFacts.length > 0 && transcript === null) {
    throw new CatalogError('Transcript facts exist but the run has no transcript');
  }
  const turns = transcript?.turns ?? [];
  const spoken = [...spokenFacts].sort(transcriptOrder(turns)).map((fact, i) => {
    if (fact.source.kind !== 'transcript_turn') throw new CatalogError('Unexpected fact source');
    if (fact.source.transcriptArtifactId !== transcript?.artifactId) {
      throw new CatalogError('A transcript fact cites a different transcript than the run has');
    }
    return catalogFact(fact, sequenceId('C', i + 1));
  });

  // Photo regions: photos in inventory (upload) order, observations in inventory order.
  const inventory = sources.inventory;
  if (photoFacts.length > 0 && inventory === null) {
    throw new CatalogError('Photo facts exist but the run has no photo inventory');
  }
  const remaining = new Set(photoFacts);
  const photoItems: CatalogFact[] = [];
  const photos: ReconciliationInput['photos'] = [];
  let photoNumber = 0;
  for (const photo of inventory?.photos ?? []) {
    // Observations exist only for classified photos; a fact on any other photo stays in
    // `remaining` and fails the catalog below.
    if (photo.classification.status !== 'ok') continue;
    const observations: ReconciliationInput['photos'][number]['observations'] = [];
    const photoId = sequenceId('P', photoNumber + 1);
    for (const observation of photo.observations) {
      const fact = [...remaining].find(
        (candidate) =>
          candidate.source.kind === 'photo_region' &&
          candidate.source.materialId === photo.materialId &&
          candidate.key === observation.key,
      );
      if (fact === undefined) continue;
      remaining.delete(fact);
      const item = catalogFact(fact, `${photoId}.R${observations.length + 1}`);
      if (typeof item.value !== 'number' || !Number.isInteger(item.value) || item.value < 1) {
        throw new CatalogError('A photo fact does not hold an instance count');
      }
      photoItems.push(item);
      observations.push({
        id: item.evidenceId,
        key: item.key,
        label: observation.label,
        detail: observation.detail,
        count: item.value,
      });
    }
    if (observations.length === 0) continue;
    photoNumber += 1;
    const { subject, otherSubject, summary } = photo.classification;
    photos.push({
      photoId,
      room: subject === 'other' && otherSubject !== null ? otherSubject : subject,
      summary,
      observations,
    });
  }
  if (remaining.size > 0) {
    throw new CatalogError('A photo fact has no matching observation in the photo inventory');
  }

  const stated = spoken.filter((item) => item.assertion === 'stated');
  const input = {
    property: { market: market.id, sourceLanguage: market.source_languages.join(', ') },
    marketFacts: market.facts.map((fact) => ({
      key: fact.key,
      type: fact.type,
      unit: profileUnit(market, fact),
      basis: fact.type === 'area' ? fact.basis : null,
    })),
    form: form.map((item) => ({
      id: item.evidenceId,
      field: item.evidenceId.slice(2),
      value: item.value,
      unit: item.unit,
      basis: item.basis,
    })),
    transcript: turns.map((turn) => ({
      turnId: turnEvidenceId(turn.index),
      speaker: turn.speaker,
      startMs: turn.startMs,
      endMs: turn.endMs,
      text: turn.text,
    })),
    candidates: stated.map((item) => {
      if (item.fact.source.kind !== 'transcript_turn') {
        throw new CatalogError('Unexpected fact source');
      }
      const { turnIndex, quote, startMs, endMs } = item.fact.source;
      return {
        id: item.evidenceId,
        key: item.key,
        value: item.value,
        unit: item.unit,
        basis: item.basis,
        quote,
        turnId: turnEvidenceId(turnIndex),
        startMs,
        endMs,
      };
    }),
    photos,
    inventory: [],
  } satisfies ReconciliationInput;

  const parsed = reconciliationInputSchema.safeParse(input);
  if (!parsed.success) {
    // Issue messages name catalog IDs only (no values or quotes).
    const problems = parsed.error.issues.map((issue) => issue.message).slice(0, 5);
    throw new CatalogError(
      `The stored candidates do not form a valid catalog: ${problems.join('; ')}`,
    );
  }

  const items = [...form, ...spoken, ...photoItems];
  const sent = new Map<string, CatalogFact>(
    [...form, ...stated, ...photoItems].map((item) => [item.evidenceId, item]),
  );
  return { input: parsed.data, items, sent };
}
