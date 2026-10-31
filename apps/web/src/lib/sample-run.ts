// The facts about the sample run that the landing page states. Static on purpose: the landing page
// makes no API call, and every value here is something a visitor can check against the sample file
// (`/demo`) or the repository. `__tests__/sample-run.test.ts` ties what can be tied to the committed
// fixtures (the recorded transcript, the project's fact form, the README eval table).
//
// Where each value comes from:
// - the walkthrough transcript: `fixtures/meta/p3-10/synthetic-walkthrough.json` (the recorded
//   voice transcription the demo seed replays),
// - the fact form and the photo list: `fixtures/projects/synthetic-walkthrough/project.json`,
// - the counts of conflicts, sentences, staged images, and files: the demo run's own screens, as
//   `npm run demo:seed` produces them (Gate 1, Gate 2, and the pack),
// - the eval numbers: the README "Eval results" table.
// If the cassette or the pipeline is re-recorded, re-seed the demo and re-check these values.

export type SampleScreen = 'monitor' | 'conflicts' | 'review' | 'pack';

/** The one conflict the specimen tells, and the form and voice values on its two sides. */
export const BUILD_YEAR = { form: 1986, voice: 1987 } as const;

/** Counts the ledger states. Each is visible on the screen named in `landing-sources.ts`. */
export const SAMPLE_COUNTS = {
  /** Photos in `project.json`; the pack lists these plus the one staged image. */
  photos: 11,
  conflicts: 3,
  portalSentences: 14,
  socialSentences: 3,
  buyerQuestions: 7,
  buyerAnswers: 15,
  /** Every sentence audited in the one pass: portal + social + buyer answers. */
  auditedSentences: 32,
  flaggedClaims: 0,
  exportedFiles: 14,
} as const;

export type SpecimenClaimId = 'year' | 'label' | 'issued';

/** A piece of the specimen sentence: plain text, or a claim with evidence. */
export type SpecimenPart = { text: string } | { claim: SpecimenClaimId; text: string };

/**
 * One sentence of the sample run's approved portal copy (model output in English; it is shown as
 * written and never translated).
 */
export const SPECIMEN_SENTENCE =
  'The building dates from 1987 and has energy label B issued in 2023.';

export const SPECIMEN_PARTS: readonly SpecimenPart[] = [
  { text: 'The building dates from ' },
  { claim: 'year', text: '1987' },
  { text: ' and has ' },
  { claim: 'label', text: 'energy label B' },
  { text: ' ' },
  { claim: 'issued', text: 'issued in 2023' },
  { text: '.' },
];

export type FormFieldKey = 'build_year' | 'energy_label';

export type SpecimenEvidence =
  /** A turn of the Dutch walkthrough: when it was said, and the words the fact was read from. */
  | { kind: 'voice'; startMs: number; endMs: number; quote: string }
  /** A field of the fact form; `used` is false when the run kept the other side of a conflict. */
  | { kind: 'form'; field: FormFieldKey; value: string; used: boolean };

export const SPECIMEN_EVIDENCE: Record<SpecimenClaimId, readonly SpecimenEvidence[]> = {
  year: [
    { kind: 'voice', startMs: 11180, endMs: 19420, quote: 'in 1987 gebouwd' },
    { kind: 'form', field: 'build_year', value: String(BUILD_YEAR.form), used: false },
  ],
  label: [
    { kind: 'form', field: 'energy_label', value: 'B', used: true },
    { kind: 'voice', startMs: 26940, endMs: 44940, quote: 'Het energielabel is B' },
    { kind: 'voice', startMs: 157900, endMs: 169100, quote: 'energielabel B' },
  ],
  issued: [{ kind: 'voice', startMs: 26940, endMs: 44940, quote: 'afgegeven in 2023' }],
};

/** The claim open when the page loads: the one with a conflict behind it. */
export const SPECIMEN_FIRST_CLAIM: SpecimenClaimId = 'year';

export type ExampleClaimId = 'place' | 'area' | 'floor';

/**
 * The landing page's claim example: the first sentence of the sample run's approved portal copy
 * (model output in English, never translated). It carries no conflict, so the example stays short;
 * the conflict stories belong on a detail page.
 */
export const EXAMPLE_SENTENCE =
  'This apartment in Zandmeer offers 92 m² of living space on floor 2.';

export const EXAMPLE_PARTS: readonly (
  { text: string } | { claim: ExampleClaimId; text: string }
)[] = [
  { text: 'This apartment in ' },
  { claim: 'place', text: 'Zandmeer' },
  { text: ' offers ' },
  { claim: 'area', text: '92 m²' },
  { text: ' of living space on ' },
  { claim: 'floor', text: 'floor 2' },
  { text: '.' },
];

export type ExampleEvidence =
  | { kind: 'voice'; startMs: number; endMs: number; quote: string }
  | { kind: 'form'; field: 'place_name' | 'living_area'; value: string };

export const EXAMPLE_EVIDENCE: Record<ExampleClaimId, readonly ExampleEvidence[]> = {
  place: [{ kind: 'form', field: 'place_name', value: 'Zandmeer' }],
  area: [
    { kind: 'form', field: 'living_area', value: '92 m²' },
    { kind: 'voice', startMs: 19500, endMs: 26940, quote: '92 vierkante meter' },
  ],
  floor: [{ kind: 'voice', startMs: 60, endMs: 10780, quote: 'op de tweede verdieping' }],
};

export const EXAMPLE_FIRST_CLAIM: ExampleClaimId = 'area';

/** The ten steps of the run in order, with the two review gates after their steps. */
export const LEDGER_ROWS = [
  { id: 'intake', kind: 'step' },
  { id: 'fact_extraction', kind: 'step' },
  { id: 'vision_inventory', kind: 'step' },
  { id: 'reconciliation', kind: 'step', photo: 'bedroom' },
  { id: 'gate1', kind: 'gate' },
  { id: 'creative', kind: 'step' },
  { id: 'qa_cards', kind: 'step' },
  { id: 'staging', kind: 'step', photo: 'staging' },
  { id: 'integrity', kind: 'step' },
  { id: 'verification', kind: 'step' },
  { id: 'gate2', kind: 'gate' },
  { id: 'export', kind: 'step' },
] as const;

export type LedgerRowId = (typeof LEDGER_ROWS)[number]['id'];

/**
 * What each ledger row's message interpolates. `sample-run.test.ts` checks that these are exactly
 * the placeholders of the English (and every other) message.
 */
export const LEDGER_PARAMS = {
  vision_inventory: { photos: SAMPLE_COUNTS.photos },
  reconciliation: { conflicts: SAMPLE_COUNTS.conflicts },
  gate1: { voice: BUILD_YEAR.voice, form: BUILD_YEAR.form },
  creative: { portal: SAMPLE_COUNTS.portalSentences, social: SAMPLE_COUNTS.socialSentences },
  qa_cards: { questions: SAMPLE_COUNTS.buyerQuestions, answers: SAMPLE_COUNTS.buyerAnswers },
  verification: {
    audited: SAMPLE_COUNTS.auditedSentences,
    flagged: SAMPLE_COUNTS.flaggedClaims,
  },
  export: { files: SAMPLE_COUNTS.exportedFiles },
} as const;

export type SamplePhotoId = 'cover' | 'bedroom' | 'stagingBefore' | 'stagingAfter';

export interface SamplePhoto {
  /** File prefix in `public/images/sample-run/` (`<name>-<width>.webp`). */
  readonly name: string;
  readonly widths: readonly number[];
  /** Intrinsic size of the largest variant, so the browser reserves the ratio before it loads. */
  readonly width: number;
  readonly height: number;
}

// Built by `apps/web/scripts/build-sample-run-images.mjs` from committed synthetic fixtures.
export const SAMPLE_PHOTOS = {
  cover: { name: 'cover', widths: [480, 960], width: 960, height: 639 },
  bedroom: { name: 'bedroom', widths: [480, 960], width: 960, height: 639 },
  stagingBefore: { name: 'staging-before', widths: [480, 960], width: 960, height: 639 },
  stagingAfter: { name: 'staging-after', widths: [480, 960], width: 960, height: 640 },
} as const satisfies Record<SamplePhotoId, SamplePhoto>;

export function samplePhotoSrc(photo: SamplePhoto, width: number): string {
  return `/images/sample-run/${photo.name}-${width}.webp`;
}

export function samplePhotoSrcSet(photo: SamplePhoto): string {
  return photo.widths.map((w) => `${samplePhotoSrc(photo, w)} ${w}w`).join(', ');
}

/** The eval run behind the numbers table (README "Eval results"). */
export const EVAL_RUN = { date: '2026-10-30', sets: 6 } as const;

export const EVAL_ROWS = [
  { id: 'planted', result: '14 / 14' },
  { id: 'falseConflicts', result: '0' },
  { id: 'injectedFlagged', result: '15 / 15' },
  { id: 'injectedAtGate2', result: '0' },
  { id: 'injectedExported', result: '0' },
  { id: 'cleanFlags', result: '6' },
] as const;

export type EvalRowId = (typeof EVAL_ROWS)[number]['id'];

/**
 * The statements of "What it will not do, and what it removes" on `/method`: five boundaries, then
 * what it strips, blurs, deletes, and never trains on. This list is also the site's short
 * data-handling statement.
 */
export const BOUNDARY_IDS = [
  'valuation',
  'legal',
  'buyers',
  'publishing',
  'edits',
  'metadata',
  'blur',
  'deletion',
  'training',
] as const;

export type BoundaryId = (typeof BOUNDARY_IDS)[number];
