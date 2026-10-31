import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import {
  BOUNDARY_IDS,
  BUILD_YEAR,
  EVAL_ROWS,
  EVAL_RUN,
  LEDGER_ROWS,
  SAMPLE_COUNTS,
  SPECIMEN_EVIDENCE,
  SPECIMEN_PARTS,
  SPECIMEN_SENTENCE,
} from '../lib/sample-run';
import { referencedPaths, SOURCE_NOTE_IDS, SOURCE_NOTES, sourceHref } from '../lib/landing-sources';

// The landing page states facts about the sample run. These tests tie every fact that a committed
// fixture can prove to that fixture, so the page cannot drift from the run it describes.
const REPO = resolve(__dirname, '../../../..');
const read = (path: string): string => readFileSync(resolve(REPO, path), 'utf8');

interface Turn {
  turnId: number;
  startMs: number;
  endMs: number;
  transcript: string;
}
interface Cassette {
  interactions: { response: { body: { value?: { turns?: Turn[] } } } }[];
}
const cassetteText = read('fixtures/meta/p3-10/synthetic-walkthrough.json');
const turns: Turn[] =
  (JSON.parse(cassetteText) as Cassette).interactions[0]?.response.body.value?.turns ?? [];
const project = JSON.parse(read('fixtures/projects/synthetic-walkthrough/project.json')) as {
  factForm: Record<string, unknown>;
  photos: string[];
};

describe('the specimen', () => {
  it('is assembled from its parts without losing a character', () => {
    expect(SPECIMEN_PARTS.map((part) => part.text).join('')).toBe(SPECIMEN_SENTENCE);
  });

  it('is a sentence of the approved copy the demo run replays (the recorded creative response)', () => {
    expect(cassetteText).toContain(SPECIMEN_SENTENCE);
  });

  it('quotes real turns of the recorded walkthrough, at the times the demo shows', () => {
    const voice = Object.values(SPECIMEN_EVIDENCE)
      .flat()
      .filter((item) => item.kind === 'voice');
    expect(voice.length).toBeGreaterThan(0);
    for (const item of voice) {
      const turn = turns.find((t) => t.startMs === item.startMs);
      expect(turn, `a turn starts at ${item.startMs}`).toBeDefined();
      expect(turn?.endMs).toBe(item.endMs);
      expect(turn?.transcript).toContain(item.quote);
    }
  });

  it('shows the form values the sample project really holds', () => {
    expect(project.factForm['build_year']).toBe(BUILD_YEAR.form);
    expect(project.factForm['energy_label']).toBe('B');
    const forms = Object.values(SPECIMEN_EVIDENCE)
      .flat()
      .filter((item) => item.kind === 'form');
    for (const item of forms) expect(String(project.factForm[item.field])).toBe(item.value);
    // The spoken year that replaced it.
    expect(turns.find((t) => t.startMs === 11180)?.transcript).toContain(String(BUILD_YEAR.voice));
  });
});

describe('the ledger', () => {
  it('counts the photos of the sample project', () => {
    expect(project.photos).toHaveLength(SAMPLE_COUNTS.photos);
  });

  it('adds the audited sentences up from the parts it states', () => {
    expect(SAMPLE_COUNTS.auditedSentences).toBe(
      SAMPLE_COUNTS.portalSentences + SAMPLE_COUNTS.socialSentences + SAMPLE_COUNTS.buyerAnswers,
    );
  });

  it('has the ten steps of the service definition and the two stops, in order', () => {
    const definition = read('definitions/services/listing-launch.v1.yaml');
    const stepIds = LEDGER_ROWS.filter((row) => row.kind === 'step').map((row) => row.id);
    expect(stepIds).toHaveLength(10);
    let at = 0;
    for (const id of stepIds) {
      const next = definition.indexOf(id, at);
      expect(next, `${id} appears in order in the definition`).toBeGreaterThanOrEqual(at);
      at = next;
    }
  });

  it('has a message for every row and every number it interpolates', () => {
    for (const row of LEDGER_ROWS) expect(en.landing.ledger.rows[row.id]).toBeTruthy();
  });
});

describe('the eval numbers', () => {
  const readme = read('README.md');
  const results: Record<string, string> = {
    planted: 'Planted conflicts surfaced at Gate 1',
    falseConflicts: 'Unexpected (false) conflicts',
    injectedFlagged: 'Injected claim defects flagged in the first audit',
    injectedAtGate2: 'Injected defects still unflagged at Gate 2',
    injectedExported: 'Injected defects in an exported pack',
    cleanFlags: 'First-audit flags on uninjected segments',
  };

  it.each(EVAL_ROWS)('$id matches the README table', (row) => {
    const line = readme.split('\n').find((l) => l.startsWith(`| ${results[row.id]}`));
    expect(line, `README row for ${row.id}`).toBeDefined();
    const cell = line?.split('|')[2]?.trim() ?? '';
    // "14 / 14 (6 / 6 by code, ...)" or "0 (all 15 were revised away)": the leading figure.
    expect(cell.startsWith(row.result)).toBe(true);
  });

  it('is dated like the README says', () => {
    expect(readme).toContain(`recorded ${EVAL_RUN.date}`);
    expect(readme).toContain(`six synthetic sets`);
    expect(EVAL_RUN.sets).toBe(6);
  });
});

describe('source notes', () => {
  it('has a note for every claim the page marks, and one per boundary', () => {
    for (const id of BOUNDARY_IDS) expect(SOURCE_NOTES).toHaveProperty(id);
    expect(new Set(SOURCE_NOTE_IDS).size).toBe(SOURCE_NOTE_IDS.length);
  });

  it('points only at files that exist in the repository', () => {
    for (const path of referencedPaths()) {
      expect(existsSync(resolve(REPO, path)), path).toBe(true);
    }
  });

  it('anchors README and product links at headings that exist', () => {
    expect(read('README.md')).toMatch(/^## Eval results$/m);
    const product = read('docs/product.md');
    expect(product).toMatch(/^## 8\. Hard boundaries$/m);
    expect(product).toMatch(/^## 9\. Data, privacy, and trust$/m);
    const hrefs = Object.values(SOURCE_NOTES).flatMap((refs) => refs.map(sourceHref));
    expect(hrefs).toContain('https://github.com/EtkinD/evidomo/blob/main/README.md#eval-results');
    expect(hrefs).toContain(
      'https://github.com/EtkinD/evidomo/blob/main/docs/product.md#8-hard-boundaries',
    );
    expect(hrefs).toContain(
      'https://github.com/EtkinD/evidomo/blob/main/docs/product.md#9-data-privacy-and-trust',
    );
  });

  it('sends sample notes to screens the demo entry understands', () => {
    for (const href of Object.values(SOURCE_NOTES)
      .flatMap((refs) => refs.map(sourceHref))
      .filter((h) => h.startsWith('/demo'))) {
      expect(href).toMatch(/^\/demo(\?tab=(conflicts|review|pack))?$/);
    }
  });
});
