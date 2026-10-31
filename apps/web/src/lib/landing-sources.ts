import { repositoryFileUrl } from './repository';
import type { SampleScreen } from './sample-run';

/**
 * Where a claim on the landing page, or a section of `/method`, can be checked ("no source, no
 * sentence"). Four kinds: `sample` (a screen of the sample file, `/demo`), `eval` (the README eval
 * report), `code` (the file that enforces it), `rule` (a section of `docs/product.md`), plus
 * `sampleFile` for a committed fixture of the sample run. On the landing page a `sample` or `rule`
 * reference may lead to the matching `/method` section instead (`method`).
 * `__tests__/sample-run.test.ts` checks that every path exists in the repository.
 */
export type MethodAnchor = 'sources' | 'sample-run' | 'numbers' | 'limits-and-data';

/** The sections of `/method` in page order: the § number is the position plus one. */
export const METHOD_ANCHORS: readonly MethodAnchor[] = [
  'sources',
  'sample-run',
  'numbers',
  'limits-and-data',
];

export const methodSectionNumber = (anchor: MethodAnchor): number =>
  METHOD_ANCHORS.indexOf(anchor) + 1;

export type SourceRef =
  | { kind: 'sample'; screen: SampleScreen; detail?: string; method?: MethodAnchor }
  | { kind: 'sampleFile'; path: string }
  | { kind: 'eval' }
  | { kind: 'code'; path: string }
  | { kind: 'rule'; section: 8 | 9; method?: MethodAnchor };

const sample = (screen: SampleScreen, method?: MethodAnchor): SourceRef =>
  method === undefined ? { kind: 'sample', screen } : { kind: 'sample', screen, method };
const code = (path: string): SourceRef => ({ kind: 'code', path });
const file = (path: string): SourceRef => ({ kind: 'sampleFile', path });

/**
 * The claims the landing page marks behind "Show sources", in page order (so its footnotes read 1
 * to 6): the ones a visitor would doubt. One compact note each.
 */
export const SOURCE_NOTES = {
  lede: [code('apps/api/src/pipeline/claims/validator.ts')],
  stops: [sample('conflicts', 'sample-run')],
  example: [sample('review', 'sources'), file('fixtures/projects/synthetic-walkthrough/README.md')],
  labelled: [sample('review', 'sample-run')],
  private: [code('apps/api/src/media/image.ts'), code('apps/api/src/export/blur.ts')],
  limits: [{ kind: 'rule', section: 8, method: 'limits-and-data' }],
} as const satisfies Record<string, readonly SourceRef[]>;

/**
 * The sources `/method` lists at the end of each section: compact, numbered, one link each. They
 * back the whole section, so the page needs no margin note on any line.
 */
export const METHOD_SOURCES = {
  sources: [
    sample('review'),
    sample('conflicts'),
    file('fixtures/projects/synthetic-walkthrough/README.md'),
    code('apps/api/src/pipeline/claims/validator.ts'),
  ],
  'sample-run': [
    sample('conflicts'),
    sample('review'),
    sample('pack'),
    file('fixtures/projects/synthetic-walkthrough/decisions.json'),
    file('fixtures/meta/p3-10/synthetic-walkthrough.json'),
    file('fixtures/samples/synthetic-interiors/README.md'),
    code('apps/api/src/pipeline/integrity/check.ts'),
  ],
  numbers: [
    { kind: 'eval' },
    file('fixtures/meta/p1-04/walkthrough-nl.txt'),
    code('apps/api/src/pipeline/verification/prompt.ts'),
  ],
  'limits-and-data': [
    { kind: 'rule', section: 8 },
    { kind: 'rule', section: 9 },
    code('apps/api/src/media/image.ts'),
    code('apps/api/src/export/blur.ts'),
    code('apps/api/src/projects/projects.ts'),
    code('apps/api/src/meta/clients.ts'),
    code('apps/api/src/pipeline/checklist/evaluate.ts'),
    code('apps/api/src/pipeline/integrity/check.ts'),
  ],
} as const satisfies Record<MethodAnchor, readonly SourceRef[]>;

export type SourceNoteId = keyof typeof SOURCE_NOTES;

export const SOURCE_NOTE_IDS = Object.keys(SOURCE_NOTES) as SourceNoteId[];

export function noteNumber(id: SourceNoteId): number {
  return SOURCE_NOTE_IDS.indexOf(id) + 1;
}

const RULE_ANCHORS = { 8: '8-hard-boundaries', 9: '9-data-privacy-and-trust' } as const;

/** Where a reference leads: a `/method` section, a sample screen, or a file on `main`. */
export function sourceHref(ref: SourceRef): string {
  switch (ref.kind) {
    case 'sample':
      if (ref.method !== undefined) return `/method#${ref.method}`;
      return ref.screen === 'monitor' ? '/demo' : `/demo?tab=${ref.screen}`;
    case 'sampleFile':
    case 'code':
      return repositoryFileUrl(ref.path);
    case 'eval':
      return repositoryFileUrl('README.md', 'eval-results');
    case 'rule':
      if (ref.method !== undefined) return `/method#${ref.method}`;
      return repositoryFileUrl('docs/product.md', RULE_ANCHORS[ref.section]);
  }
}

/** Repository paths the references point at, for the test that checks they exist. */
export function referencedPaths(): string[] {
  const paths = new Set<string>(['README.md', 'docs/product.md']);
  const all = [...Object.values(SOURCE_NOTES), ...Object.values(METHOD_SOURCES)];
  for (const refs of all) {
    for (const ref of refs)
      if (ref.kind === 'code' || ref.kind === 'sampleFile') paths.add(ref.path);
  }
  return [...paths];
}
