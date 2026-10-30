import { randomUUID } from 'node:crypto';
import {
  STAGED_IMAGE_LABEL,
  portalFieldsSchema,
  type ApprovedPackContent,
  type MarketProfile,
  type PortalFields,
  type PortalImage,
  type PublicationChecklistResult,
} from '@evidomo/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Fact } from '../db/repositories/facts.ts';
import { loadDefinitions } from '../definitions/loader.ts';
import { evaluatePublicationChecklist } from '../pipeline/checklist/evaluate.ts';
import { storedFact } from '../pipeline/reconciliation/testing.ts';
import { STAGED_DIGITAL_SOURCE_TYPE } from '../pipeline/staging/encode.ts';
import { escapeHtml } from './escape.ts';
import { buildPortalFacts } from './facts.ts';
import { formatApprovedAt, renderListingPackHtml, type ListingPackHtmlInput } from './html.ts';
import {
  composePortalFields,
  copyVariant,
  qaCards,
  serializePortalFields,
} from './portal-fields.ts';
import { syntheticPhoto } from './testing.ts';

// The HTML pack and the portal-fields JSON from synthetic parts: escaping of every untrusted
// string, the sections, the not-ready notice, determinism, and the JSON's stable form.

const PAYLOAD = `<script>alert("x")</script><img src=x onerror='y'> & co`;
const RUN = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const MATERIAL_A = '0b7f2a0e-5c1d-4d6e-9a51-00000000000a';
const MATERIAL_B = '0b7f2a0e-5c1d-4d6e-9a51-00000000000b';
const STAGED = '0b7f2a0e-5c1d-4d6e-9a51-0000000000c1';

let nl: MarketProfile;
let international: MarketProfile;
let small: Uint8Array;

beforeAll(async () => {
  const registry = await loadDefinitions();
  nl = registry.getMarket('nl', 1);
  international = registry.getMarket('international', 1);
  small = await syntheticPhoto([200, 190, 180], [], { width: 64, height: 43 });
});

function verified(
  key: string,
  value: number | string | boolean,
  unit: string | null = null,
  basis: string | null = null,
): Fact {
  return storedFact(RUN, {
    stepId: 'reconciliation',
    status: 'verified',
    key,
    value,
    unit,
    basis,
    source: { kind: 'form', field: key },
  });
}

function pack(overrides: Partial<ApprovedPackContent> = {}): ApprovedPackContent {
  const segment = (
    index: number,
    paragraph: number,
    text: string,
    origin: 'unflagged' | 'accepted' | 'edited',
  ) => ({
    claimId: randomUUID(),
    index,
    paragraph,
    text,
    factIds: [randomUUID()],
    origin,
  });
  return {
    schemaVersion: 1,
    claimAuditArtifactId: randomUUID(),
    finalDraftArtifactId: randomUUID(),
    finalQaArtifactId: null,
    integrityChecksArtifactId: randomUUID(),
    outputLanguage: 'en',
    variants: [
      {
        kind: 'portal',
        segments: [
          segment(0, 0, 'This apartment offers 92.5 m² of living space.', 'unflagged'),
          segment(1, 0, PAYLOAD, 'accepted'),
          segment(2, 1, 'It has a balcony.', 'edited'),
        ],
      },
      { kind: 'social', segments: [segment(3, 0, 'Bright and calm.', 'unflagged')] },
    ],
    qaCards: [],
    removedClaimIds: [],
    images: [],
    warnings: [],
    approvedBy: randomUUID(),
    approvedAt: '2026-10-29T14:03:12.000Z',
    ...overrides,
  };
}

const IMAGES: PortalImage[] = [
  {
    position: 1,
    fileName: 'photo-01-staged.jpg',
    fileArtifactId: randomUUID(),
    materialId: MATERIAL_A,
    width: 64,
    height: 43,
    sizeBytes: 1000,
    sha256: 'a'.repeat(64),
    kind: 'staged',
    stagedArtifactId: STAGED,
    operationId: 'furnish_living_room',
    disclosure: {
      label: STAGED_IMAGE_LABEL,
      burnedIn: true,
      digitalSourceType: STAGED_DIGITAL_SOURCE_TYPE,
    },
    originalFileName: 'photo-01.jpg',
  },
  {
    position: 2,
    fileName: 'photo-01.jpg',
    fileArtifactId: randomUUID(),
    materialId: MATERIAL_A,
    width: 64,
    height: 43,
    sizeBytes: 1000,
    sha256: 'b'.repeat(64),
    kind: 'original',
    coverRank: 1,
    subject: 'living_room',
    privacy: { status: 'clear', blurredRegions: 0 },
    stagedFileName: 'photo-01-staged.jpg',
  },
  {
    position: 3,
    fileName: 'photo-02.jpg',
    fileArtifactId: randomUUID(),
    materialId: MATERIAL_B,
    width: 64,
    height: 43,
    sizeBytes: 1000,
    sha256: 'c'.repeat(64),
    kind: 'original',
    coverRank: 2,
    subject: 'bedroom',
    privacy: { status: 'masked', blurredRegions: 2 },
    stagedFileName: null,
  },
];

function checklist(facts: readonly Fact[]): PublicationChecklistResult {
  return evaluatePublicationChecklist({
    market: nl,
    facts,
    copy: { segments: [] },
    claimAudit: null,
    stagedImages: [
      { artifactId: STAGED, disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true } },
    ],
  });
}

function fields(options: { energyLabel?: boolean; language?: string } = {}): PortalFields {
  const facts = [
    verified('living_area', 92.5, 'm2', 'NEN2580'),
    verified('build_year', 1932),
    verified('other:street_character', PAYLOAD),
    ...(options.energyLabel === false ? [] : [verified('energy_label', 'B')]),
  ];
  return composePortalFields({
    runId: RUN,
    pack: { artifactId: randomUUID(), content: pack({ outputLanguage: options.language ?? 'en' }) },
    market: nl,
    facts: buildPortalFacts(nl, facts, null),
    images: IMAGES,
    withheld: [
      {
        materialId: randomUUID(),
        uploadPosition: 4,
        kind: 'original',
        stagedArtifactId: null,
        reason: 'privacy_review',
      },
    ],
    checklist: checklist(facts),
  });
}

function input(
  portalFields: PortalFields,
  overrides: Partial<ListingPackHtmlInput> = {},
): ListingPackHtmlInput {
  return {
    fields: portalFields,
    market: nl,
    title: `Canal house ${PAYLOAD}`,
    office: { agencyName: `Agency ${PAYLOAD}`, contactBlock: `Line one\n${PAYLOAD}` },
    images: new Map(IMAGES.map((image) => [image.fileName, small])),
    warnings: [],
    flagCategories: new Map(),
    ...overrides,
  };
}

/** Two approved Q&A cards, one answer approved as written with untrusted text. */
function qaPack(): ApprovedPackContent {
  const qaSegment = (index: number, text: string, origin: 'unflagged' | 'accepted') => ({
    claimId: randomUUID(),
    index,
    text,
    factIds: [randomUUID()],
    origin,
  });
  return pack({
    finalQaArtifactId: randomUUID(),
    qaCards: [
      {
        card: 0,
        question: 'How large is the living area?',
        segments: [
          qaSegment(0, 'The living area is 92.5 m².', 'unflagged'),
          qaSegment(1, 'It is measured to NEN 2580.', 'unflagged'),
        ],
      },
      {
        card: 2,
        question: `Is there a balcony ${PAYLOAD}?`,
        segments: [qaSegment(2, PAYLOAD, 'accepted')],
      },
    ],
  });
}

describe('renderListingPackHtml', () => {
  it('is a self-contained, print-ready document in the output language', () => {
    const html = renderListingPackHtml(input(fields()));
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(
      `content="default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;"`,
    );
    expect(html).toContain('@page{size:A4');
    for (const id of ['copy', 'facts', 'photos', 'checklist'])
      expect(html).toContain(`<section id="${id}">`);
    // No script, no external resource: images are data URIs only.
    expect(html).not.toMatch(/<script|<link|src="(?!data:image\/jpeg;base64,)/);
    expect(html.match(/<img /g)).toHaveLength(3);
  });

  it('escapes every untrusted string: title, office, copy, fact values', () => {
    const html = renderListingPackHtml(input(fields()));
    expect(html).not.toContain(PAYLOAD);
    expect(html).not.toContain('<img src=x');
    const escaped = escapeHtml(PAYLOAD);
    // Title (twice), agency (header and footer), contact line, copy segment (twice: text and
    // override), and the other: fact value.
    expect(html.split(escaped).length - 1).toBeGreaterThanOrEqual(7);
  });

  it('signs the footer with the inline Evidomo mark and name, no external image', () => {
    const html = renderListingPackHtml(input(fields()));
    const footer = html.slice(html.indexOf('<footer>'), html.indexOf('</footer>'));
    expect(footer).toMatch(
      /<p class="made"><svg [^>]*aria-hidden="true"[^>]*>.*<\/svg><span>Evidomo<\/span> · /,
    );
    expect(footer).not.toMatch(/<img|href=|url\(/);
  });

  it('renders the copy by paragraph, the fact sheet, and the checklist items', () => {
    const html = renderListingPackHtml(input(fields()));
    expect(html).toContain(
      `<p>This apartment offers 92.5 m² of living space. ${escapeHtml(PAYLOAD)}</p>`,
    );
    expect(html).toContain('<p>It has a balcony.</p>');
    expect(html).toContain('<th scope="row">Energy label (energielabel)</th><td>B</td>');
    expect(html).toContain('<td>92.5 m²</td>');
    expect(html).toContain('<td>1932</td>');
    expect(html).toMatch(/Volume \(inhoud\)<\/th><td><span class="missing">Not verified/);
    expect(html).toContain('The energy label class is shown in the listing');
    expect(html).toContain('status-pass');
  });

  it('shows the staged image labeled, next to its original, and lists withheld photos', () => {
    const html = renderListingPackHtml(input(fields()));
    expect(html).toMatch(
      /<div class="pair"><figure><img [^>]+alt="Photo 1, Virtually staged"[^>]*><figcaption><span class="label">Virtually staged<\/span>Photo 1<\/figcaption><\/figure><figure><img [^>]+alt="Photo 1, Original"/,
    );
    expect(html).toContain('Photo 2 · faces and license plates blurred');
    expect(html).toContain('<li>Upload 4: withheld: privacy check incomplete</li>');
  });

  it('shows a not-ready notice naming the failing items and the accepted overrides', () => {
    const notReady = renderListingPackHtml(input(fields({ energyLabel: false })));
    const notice =
      /<section class="notice" id="not-ready"[\s\S]*?<\/section>/.exec(notReady)?.[0] ?? '';
    expect(notice).toContain('Not ready to publish');
    expect(notice).toContain('1 publication checklist item fails');
    expect(notice).toContain('<li>The energy label class is shown in the listing</li>');
    expect(notice).toContain(escapeHtml(PAYLOAD));
    expect(notice).toContain('Rewritten at Gate 2');

    const ready = renderListingPackHtml(input(fields()));
    expect(ready).not.toContain('id="not-ready"');
    // When ready, the overrides are still named, in the checklist section.
    const checklistSection = /<section id="checklist">[\s\S]*?<\/section>/.exec(ready)?.[0] ?? '';
    expect(checklistSection).toContain('operator override');
    expect(checklistSection).toContain(escapeHtml(PAYLOAD));
  });

  it('shows an exclusionary flag approved as written as a failure, never as an override', () => {
    const base = fields();
    const accepted = base.copy.portal.segments.find((s) => s.origin === 'accepted');
    if (accepted === undefined) throw new Error('fixture has an accepted segment');
    const flagCategories = new Map([[accepted.claimId, ['exclusionary' as const]]]);
    const result = evaluatePublicationChecklist({
      market: international,
      facts: [],
      copy: {
        segments: [
          {
            claimId: accepted.claimId,
            variant: 'portal',
            factIds: accepted.factIds,
            decision: 'accept',
          },
        ],
      },
      claimAudit: {
        auditedCategories: ['claim_support', 'exclusionary'],
        remainingFlags: [{ category: 'exclusionary', claimId: accepted.claimId }],
      },
      stagedImages: [],
    });
    const item = result.items.find((i) => i.id === 'no_exclusionary_language');
    // The checklist (P3-07, main 712d413) keeps the item failing despite the decision.
    expect(item?.status).toBe('fail');
    const withItem = portalFieldsSchema.parse({
      ...base,
      market: { id: international.id, version: international.version },
      publicationChecklist: result,
    });
    const html = renderListingPackHtml(input(withItem, { market: international, flagCategories }));
    const notice =
      /<section class="notice" id="not-ready"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(notice).toContain('Not ready to publish');
    expect(notice).toContain('<li>No exclusionary phrasing remains</li>');
    expect(notice).toContain(
      'Approved as written, which is not allowed for exclusionary language: edit or remove before publishing',
    );
    expect(notice).toContain(escapeHtml(PAYLOAD));
    // Not listed as an allowed override.
    expect(notice).toContain('No flagged text was approved as written.');
    expect(html).toMatch(
      /status-fail">Fail<\/span><\/td><td>[^<]*approved as written, which this category does not allow/,
    );

    // A market without a phrasing item still gets the refusal, under a review notice.
    const nlHtml = renderListingPackHtml(input(base, { flagCategories }));
    expect(base.publicationChecklist.summary.readyToPublish).toBe(true);
    const nlNotice =
      /<section class="notice" id="not-ready"[\s\S]*?<\/section>/.exec(nlHtml)?.[0] ?? '';
    expect(nlNotice).toContain('Review before publishing');
    expect(nlNotice).toContain('not allowed for exclusionary language');
    const checklistSection = /<section id="checklist">[\s\S]*?<\/section>/.exec(nlHtml)?.[0] ?? '';
    expect(checklistSection).not.toContain(escapeHtml(PAYLOAD));
  });

  it('keeps other categories approved as written as operator overrides', () => {
    const base = fields();
    const accepted = base.copy.portal.segments.find((s) => s.origin === 'accepted');
    if (accepted === undefined) throw new Error('fixture has an accepted segment');
    const html = renderListingPackHtml(
      input(base, {
        flagCategories: new Map([[accepted.claimId, ['unverifiable_superlative' as const]]]),
      }),
    );
    expect(html).not.toContain('id="not-ready"');
    const checklistSection = /<section id="checklist">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(checklistSection).toContain('operator override');
    expect(checklistSection).toContain(escapeHtml(PAYLOAD));
  });

  it('renders Gate 2 warnings and an empty variant', () => {
    const base = fields();
    const emptied = portalFieldsSchema.parse({
      ...base,
      copy: { ...base.copy, social: { text: '', segments: [] } },
    });
    const html = renderListingPackHtml(
      input(emptied, {
        warnings: [
          {
            kind: 'market_fact_unmentioned',
            variant: 'portal',
            factKey: 'energy_label',
            required: true,
            removedClaimIds: [randomUUID()],
          },
          { kind: 'variant_empty', variant: 'social' },
        ],
      }),
    );
    expect(html).toContain(
      'The portal description no longer mentions Energy label (energielabel) (required by the market).',
    );
    expect(html).toContain('Every segment of the social media caption was removed.');
    expect(html).toContain('No text: every segment was removed at Gate 2.');
  });

  it('uses Dutch wording and decimal commas for a Dutch pack', () => {
    const html = renderListingPackHtml(input(fields({ language: 'nl', energyLabel: false })));
    expect(html).toContain('<html lang="nl">');
    expect(html).toContain('Nog niet klaar voor publicatie');
    expect(html).toContain('<td>92,5 m²</td>');
  });

  it('renders the approved Q&A cards escaped, and names an accepted answer as an override', () => {
    const withQa: PortalFields = { ...fields(), qaCards: qaCards(qaPack()) };
    const html = renderListingPackHtml(input(withQa));
    const section = /<section id="qa">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(section).toContain('<h2>Buyer questions and answers</h2>');
    expect(section).toContain(
      '<dt>How large is the living area?</dt><dd>The living area is 92.5 m². It is measured to NEN 2580.</dd>',
    );
    expect(section).toContain(`<dt>Is there a balcony ${escapeHtml(PAYLOAD)}?</dt>`);
    expect(section).not.toContain(PAYLOAD);
    const checklistSection = /<section id="checklist">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(checklistSection).toContain(`buyer Q&amp;A:</span> ${escapeHtml(PAYLOAD)}`);
    // No cards, no section.
    expect(renderListingPackHtml(input(fields()))).not.toContain('id="qa"');
  });

  it('is deterministic: the same input renders the same string', () => {
    const portalFields = fields();
    expect(renderListingPackHtml(input(portalFields))).toBe(
      renderListingPackHtml(input(portalFields)),
    );
  });

  it('formats the stored approval time in UTC without a clock', () => {
    expect(formatApprovedAt('2026-10-29T14:03:12.000Z')).toBe('2026-10-29 14:03');
    expect(formatApprovedAt('2026-10-29T23:30:00+02:00')).toBe('2026-10-29 21:30');
  });
});

describe('portal fields', () => {
  it('joins copy segments by paragraph and keeps them with their citations', () => {
    const variant = copyVariant(pack(), 'portal');
    expect(variant.text).toBe(
      `This apartment offers 92.5 m² of living space. ${PAYLOAD}\n\nIt has a balcony.`,
    );
    expect(variant.segments.map((s) => s.origin)).toEqual(['unflagged', 'accepted', 'edited']);
    expect(
      copyVariant(
        pack({
          variants: [
            { kind: 'portal', segments: [] },
            { kind: 'social', segments: [] },
          ],
        }),
        'social',
      ),
    ).toEqual({
      text: '',
      segments: [],
    });
  });

  it('joins each Q&A answer and keeps its segments with their citations, in card order', () => {
    const cards = qaCards(qaPack());
    expect(cards.map((card) => [card.question, card.answer])).toEqual([
      ['How large is the living area?', 'The living area is 92.5 m². It is measured to NEN 2580.'],
      [`Is there a balcony ${PAYLOAD}?`, PAYLOAD],
    ]);
    expect(cards[1]?.segments[0]).toMatchObject({ index: 2, origin: 'accepted' });
    expect(qaCards(pack())).toEqual([]);
  });

  it('serializes with the schema key order whatever the construction order', () => {
    const portalFields = fields();
    const json = serializePortalFields(portalFields);
    const shuffled = Object.fromEntries(Object.entries(portalFields).reverse());
    expect(serializePortalFields(portalFieldsSchema.parse(shuffled))).toBe(json);
    expect(Object.keys(JSON.parse(json) as object)).toEqual([
      'schemaVersion',
      'formatVersion',
      'runId',
      'approvedPackArtifactId',
      'approvedAt',
      'market',
      'outputLanguage',
      'facts',
      'copy',
      'qaCards',
      'images',
      'withheld',
      'publicationChecklist',
    ]);
    expect(json.endsWith('}\n')).toBe(true);
  });

  it('puts the checklist result in unchanged and refuses inconsistent parts', () => {
    const facts = [verified('energy_label', 'B')];
    const result = checklist(facts);
    const portalFields = composePortalFields({
      runId: RUN,
      pack: { artifactId: randomUUID(), content: pack() },
      market: nl,
      facts: buildPortalFacts(nl, facts, null),
      images: [],
      withheld: [],
      checklist: result,
    });
    expect(portalFields.publicationChecklist).toEqual(result);
    expect(() =>
      composePortalFields({
        runId: RUN,
        pack: { artifactId: randomUUID(), content: pack() },
        market: nl,
        facts: buildPortalFacts(nl, facts, null),
        images: IMAGES.slice(1),
        withheld: [],
        checklist: result,
      }),
    ).toThrow(/Positions/);
  });
});
