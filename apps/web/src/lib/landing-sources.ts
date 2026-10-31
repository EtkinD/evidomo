import { repositoryFileUrl } from './repository';
import type { SampleScreen } from './sample-run';

/**
 * The source of every factual claim on the landing page ("no source, no sentence"). A note names
 * where the claim can be checked; the "Show sources" switch reveals them. Four kinds:
 * - `sample`: a screen of the sample file (`/demo`), or a committed fixture of that run;
 * - `eval`: the README eval report;
 * - `code`: the file that enforces it;
 * - `rule`: a section of `docs/product.md`.
 * `__tests__/landing-sources.test.ts` checks that every path exists in the repository.
 */
export type SourceRef =
  | { kind: 'sample'; screen: SampleScreen; detail?: string }
  | { kind: 'sampleFile'; path: string }
  | { kind: 'eval' }
  | { kind: 'code'; path: string }
  | { kind: 'rule'; section: 8 | 9 };

const sample = (screen: SampleScreen, detail?: string): SourceRef =>
  detail === undefined ? { kind: 'sample', screen } : { kind: 'sample', screen, detail };

/** In document order: the footnote number of a note is its position here plus one. */
export const SOURCE_NOTES = {
  lede: [{ kind: 'code', path: 'apps/api/src/pipeline/claims/validator.ts' }],
  intake: [sample('conflicts', '00:11')],
  facts: [sample('conflicts'), sample('review')],
  photos: [sample('pack', 'portal-fields.json')],
  conflicts: [sample('conflicts', 'K01, K02, K03')],
  gate1: [
    sample('conflicts'),
    { kind: 'sampleFile', path: 'fixtures/projects/synthetic-walkthrough/decisions.json' },
  ],
  creative: [sample('review')],
  qa: [sample('review')],
  staging: [sample('review')],
  integrity: [sample('review'), { kind: 'code', path: 'apps/api/src/pipeline/integrity/check.ts' }],
  verification: [sample('review')],
  gate2: [sample('review')],
  export: [sample('pack')],
  evalTable: [{ kind: 'eval' }],
  limitBlatant: [{ kind: 'eval' }],
  limitOneApartment: [{ kind: 'eval' }],
  limitFreeform: [{ kind: 'eval' }],
  limitAudio: [
    sample('review'),
    { kind: 'sampleFile', path: 'fixtures/meta/p1-04/walkthrough-nl.txt' },
    { kind: 'code', path: 'apps/api/src/pipeline/verification/prompt.ts' },
  ],
  valuation: [{ kind: 'rule', section: 8 }],
  legal: [
    { kind: 'rule', section: 8 },
    { kind: 'code', path: 'apps/api/src/pipeline/checklist/evaluate.ts' },
  ],
  buyers: [{ kind: 'rule', section: 8 }],
  publishing: [{ kind: 'rule', section: 8 }],
  edits: [
    { kind: 'rule', section: 8 },
    { kind: 'code', path: 'apps/api/src/pipeline/integrity/check.ts' },
  ],
  metadata: [
    { kind: 'code', path: 'apps/api/src/media/image.ts' },
    { kind: 'rule', section: 9 },
  ],
  blur: [
    { kind: 'code', path: 'apps/api/src/export/blur.ts' },
    { kind: 'rule', section: 9 },
  ],
  deletion: [
    { kind: 'code', path: 'apps/api/src/projects/projects.ts' },
    { kind: 'rule', section: 9 },
  ],
} as const satisfies Record<string, readonly SourceRef[]>;

export type SourceNoteId = keyof typeof SOURCE_NOTES;

export const SOURCE_NOTE_IDS = Object.keys(SOURCE_NOTES) as SourceNoteId[];

export function noteNumber(id: SourceNoteId): number {
  return SOURCE_NOTE_IDS.indexOf(id) + 1;
}

const RULE_ANCHORS = { 8: '8-hard-boundaries', 9: '9-data-privacy-and-trust' } as const;

/** Where a reference leads: a sample screen, or a file on `main`. */
export function sourceHref(ref: SourceRef): string {
  switch (ref.kind) {
    case 'sample':
      return ref.screen === 'monitor' ? '/demo' : `/demo?tab=${ref.screen}`;
    case 'sampleFile':
    case 'code':
      return repositoryFileUrl(ref.path);
    case 'eval':
      return repositoryFileUrl('README.md', 'eval-results');
    case 'rule':
      return repositoryFileUrl('docs/product.md', RULE_ANCHORS[ref.section]);
  }
}

/** Repository paths the notes point at, for the test that checks they exist. */
export function referencedPaths(): string[] {
  const paths = new Set<string>(['README.md', 'docs/product.md']);
  for (const refs of Object.values(SOURCE_NOTES)) {
    for (const ref of refs)
      if (ref.kind === 'code' || ref.kind === 'sampleFile') paths.add(ref.path);
  }
  return [...paths];
}
