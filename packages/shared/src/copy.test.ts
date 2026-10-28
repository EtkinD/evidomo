import { describe, expect, it } from 'vitest';
import { copyGeneratedPayloadSchema } from './run-events.ts';
import { listingCopyContentSchema, type ListingCopyContent } from './copy.ts';

const FACT = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const segment = (index: number, catalogId = 'VF01') => ({
  index,
  paragraph: 0,
  text: 'A home of 92 m².',
  catalogIds: [catalogId],
  factIds: [FACT],
});
const content: ListingCopyContent = {
  schemaVersion: 1,
  promptVersion: 1,
  modelRun: {
    model: 'muse-spark-1.3',
    reasoningEffort: 'medium',
    maxOutputTokens: 16000,
    fallbackFrom: null,
  },
  outputLanguage: 'en',
  tone: null,
  revision: 0,
  previousArtifactId: null,
  catalog: [{ id: 'VF01', factIds: [FACT] }],
  variants: [
    { kind: 'portal', languageCheck: 'match', segments: [segment(0)] },
    { kind: 'social', languageCheck: 'inconclusive', segments: [segment(1)] },
  ],
  repairs: { mergedUncited: 0, droppedUncitedParagraphs: 0, droppedEmpty: 0 },
  counts: { catalogFacts: 1, citedCatalogFacts: 1, segments: 2 },
};

describe('listing copy content', () => {
  it('accepts portal and social copy whose segments cite catalog facts', () => {
    expect(listingCopyContentSchema.parse(content)).toEqual(content);
  });

  it('rejects uncited segments, unknown catalog IDs, gaps in segment indexes, and variant order', () => {
    const portal = content.variants[0];
    const social = content.variants[1];
    if (portal === undefined || social === undefined) throw new Error('fixture');
    const withPortal = (segments: unknown[]) => ({
      ...content,
      variants: [{ ...portal, segments }, social],
    });
    expect(
      listingCopyContentSchema.safeParse(withPortal([{ ...segment(0), factIds: [] }])).success,
    ).toBe(false);
    expect(listingCopyContentSchema.safeParse(withPortal([segment(0, 'VF02')])).success).toBe(
      false,
    );
    expect(listingCopyContentSchema.safeParse(withPortal([segment(5)])).success).toBe(false);
    expect(
      listingCopyContentSchema.safeParse({ ...content, variants: [social, portal] }).success,
    ).toBe(false);
  });

  it('requires a revision to point at the copy it revises', () => {
    expect(listingCopyContentSchema.safeParse({ ...content, revision: 1 }).success).toBe(false);
    expect(
      listingCopyContentSchema.safeParse({ ...content, revision: 1, previousArtifactId: FACT })
        .success,
    ).toBe(true);
  });
});

describe('copy_generated payload', () => {
  const summary = {
    stepId: 'creative',
    artifactId: FACT,
    revision: 0,
    outputLanguage: 'nl',
    catalogFactCount: 79,
    citedFactCount: 40,
    portalSegmentCount: 14,
    socialSegmentCount: 3,
    claimCount: 17,
    mergedUncitedCount: 0,
    droppedUncitedParagraphCount: 0,
    model: 'muse-spark-1.3',
    fallbackUsed: false,
  };

  it('carries counts only and rejects copy text', () => {
    expect(copyGeneratedPayloadSchema.parse(summary)).toEqual(summary);
    expect(copyGeneratedPayloadSchema.safeParse({ ...summary, text: 'A home' }).success).toBe(
      false,
    );
  });
});
