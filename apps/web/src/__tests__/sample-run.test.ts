import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareMeasures } from '../../../api/src/pipeline/reconciliation/compare';
import en from '../../messages/en.json';
import {
  BOUNDARY_IDS,
  BUILD_YEAR,
  EVAL_ROWS,
  EVAL_RUN,
  EXAMPLE_EVIDENCE,
  EXAMPLE_PARTS,
  EXAMPLE_SENTENCE,
  LEDGER_PARAMS,
  LEDGER_ROWS,
  SAMPLE_COUNTS,
  SPECIMEN_EVIDENCE,
  SPECIMEN_PARTS,
  SPECIMEN_SENTENCE,
} from '../lib/sample-run';
import { LANDING_IMAGES, landingSrc } from '../lib/landing-images';

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

interface RecordedInteraction {
  request: { path: string };
  response: { body: { value?: { output?: { content?: { text?: string }[] }[] } } };
}
const interactions = (JSON.parse(cassetteText) as { interactions: RecordedInteraction[] })
  .interactions;

/** The JSON a recorded model response carries as its text (null for non-JSON, e.g. SAM masks). */
function modelJson(interaction: RecordedInteraction): Record<string, unknown> | null {
  const text = interaction.response.body.value?.output
    ?.flatMap((item) => item.content ?? [])
    .find((part) => part.text !== undefined)?.text;
  if (text === undefined || !text.startsWith('{')) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
const modelResponses = interactions
  .map(modelJson)
  .filter((json): json is Record<string, unknown> => json !== null);
const withKey = (key: string) => modelResponses.filter((json) => key in json);
const length = (value: unknown): number => (Array.isArray(value) ? value.length : -1);

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

describe('the landing page claim example', () => {
  const portal = withKey('portal')[0] as {
    portal: { paragraphs: { segments: { text: string }[] }[] };
  };

  it('is assembled from its parts without losing a character', () => {
    expect(EXAMPLE_PARTS.map((part) => part.text).join('')).toBe(EXAMPLE_SENTENCE);
  });

  it('is a sentence of the approved copy the demo run replays (the recorded creative response)', () => {
    const sentences = portal.portal.paragraphs.flatMap((p) => p.segments.map((s) => s.text));
    expect(sentences).toContain(EXAMPLE_SENTENCE);
  });

  it('quotes real turns of the recorded walkthrough and the form values the sample project holds', () => {
    for (const item of Object.values(EXAMPLE_EVIDENCE).flat()) {
      if (item.kind === 'voice') {
        const turn = turns.find((t) => t.startMs === item.startMs);
        expect(turn, `a turn starts at ${item.startMs}`).toBeDefined();
        expect(turn?.endMs).toBe(item.endMs);
        expect(turn?.transcript).toContain(item.quote);
      } else if (item.field === 'living_area') {
        expect(`${String(project.factForm['living_area'])} m²`).toBe(item.value);
      } else {
        expect(project.factForm['place_name']).toBe(item.value);
      }
    }
  });
});

describe('the ledger', () => {
  const portal = withKey('portal')[0] as {
    portal: { paragraphs: { segments: unknown[] }[] };
    social: { segments: unknown[] };
  };
  const cards = (withKey('cards')[0] as { cards: { answer: unknown[] }[] }).cards;

  it('counts the photos of the sample project and the vision responses that read them', () => {
    expect(project.photos).toHaveLength(SAMPLE_COUNTS.photos);
    expect(withKey('coverScore')).toHaveLength(SAMPLE_COUNTS.photos);
  });

  it('reads the copy counts from the recorded creative and Q&A responses', () => {
    expect(
      portal.portal.paragraphs.reduce((sum, paragraph) => sum + paragraph.segments.length, 0),
    ).toBe(SAMPLE_COUNTS.portalSentences);
    expect(portal.social.segments).toHaveLength(SAMPLE_COUNTS.socialSentences);
    expect(cards).toHaveLength(SAMPLE_COUNTS.buyerQuestions);
    expect(cards.reduce((sum, card) => sum + card.answer.length, 0)).toBe(
      SAMPLE_COUNTS.buyerAnswers,
    );
    expect(SAMPLE_COUNTS.auditedSentences).toBe(
      SAMPLE_COUNTS.portalSentences + SAMPLE_COUNTS.socialSentences + SAMPLE_COUNTS.buyerAnswers,
    );
  });

  it('reads "0 flagged" from the recorded audit, which exists', () => {
    const audits = withKey('flags');
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.reduce((sum, audit) => sum + length(audit['flags']), 0)).toBe(
      SAMPLE_COUNTS.flaggedClaims,
    );
  });

  it('derives the 3 conflicts: the market facts the form and the walkthrough disagree on, plus the model’s', () => {
    // Form values with the unit and basis the Netherlands profile gives them.
    const form = {
      build_year: { value: project.factForm['build_year'], unit: null, basis: null },
      living_area: { value: project.factForm['living_area'], unit: 'm2', basis: 'NEN2580' },
      energy_label: { value: project.factForm['energy_label'], unit: null, basis: null },
      vve_monthly_contribution: {
        value: project.factForm['vve_monthly_contribution'],
        unit: 'EUR',
        basis: null,
      },
    } as const;
    const spoken = (
      withKey('facts')[0] as {
        facts: {
          key: string;
          value: string | number;
          unit: string | null;
          basis: string | null;
          assertion: string;
        }[];
      }
    ).facts.filter((fact) => fact.assertion === 'stated' && fact.key in form);
    // The code's own comparison (compare.ts): only a same-measure contradiction is a conflict.
    const contradicted = new Set(
      spoken
        .filter((fact) => {
          const side = form[fact.key as keyof typeof form];
          return (
            compareMeasures(
              {
                key: fact.key,
                value: side.value as string | number,
                unit: side.unit,
                basis: side.basis,
              },
              { key: fact.key, value: fact.value, unit: fact.unit, basis: fact.basis },
            ).relation === 'contradict'
          );
        })
        .map((fact) => fact.key),
    );
    expect([...contradicted].sort()).toEqual(['build_year', 'vve_monthly_contribution']);
    const modelConflicts = length(withKey('conflicts')[0]?.['conflicts']);
    expect(contradicted.size + modelConflicts).toBe(SAMPLE_COUNTS.conflicts);
  });

  it('derives the 14 exported files: the pack, the portal fields, every photo, and the staged image', () => {
    const staged = interactions.filter((i) => i.request.path === '/v1/images/edits').length;
    expect(staged).toBe(1);
    expect(2 + project.photos.length + staged).toBe(SAMPLE_COUNTS.exportedFiles);
  });

  it('found no face or plate in any recorded photo reading', () => {
    const readings = withKey('coverScore');
    expect(readings.length).toBeGreaterThan(0);
    for (const reading of readings) expect(reading['privacySubjects']).toEqual([]);
  });

  it('lists the definition’s steps in order, with the gates after the steps the page says', () => {
    const lines = read('definitions/services/listing-launch.v1.yaml').split('\n');
    const steps: string[] = [];
    const gates: Record<string, string> = {};
    for (const line of lines) {
      const step = /^\s+- id: (\w+)\s*$/.exec(line);
      if (step?.[1] !== undefined) steps.push(step[1]);
      const gate = /^\s+gate_after: (\w+)\s*$/.exec(line);
      if (gate?.[1] !== undefined) gates[steps[steps.length - 1] ?? ''] = gate[1];
    }
    expect(LEDGER_ROWS.filter((row) => row.kind === 'step').map((row) => row.id)).toEqual(steps);
    // A gate row follows exactly the step the definition puts its gate after.
    const gateAfterRow: Record<string, string> = { gate1: 'fact_conflicts', gate2: 'claim_audit' };
    LEDGER_ROWS.forEach((row, index) => {
      if (row.kind !== 'gate') return;
      const before = LEDGER_ROWS[index - 1]?.id ?? '';
      expect(gates[before]).toBe(gateAfterRow[row.id]);
    });
    expect(Object.keys(gates)).toHaveLength(2);
  });

  it.each(['en', 'tr', 'nl', 'it', 'es'] as const)(
    'every row has a %s message that interpolates exactly the numbers the page passes',
    (locale) => {
      const messages = JSON.parse(read(`apps/web/messages/${locale}.json`)) as typeof en;
      for (const row of LEDGER_ROWS) {
        const message: string = messages.method.ledger.rows[row.id];
        const placeholders = [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        const passed = Object.keys(
          row.id in LEDGER_PARAMS ? LEDGER_PARAMS[row.id as keyof typeof LEDGER_PARAMS] : {},
        ).sort();
        expect(placeholders, `${locale} ${row.id}`).toEqual(passed);
      }
    },
  );
});

describe('the landing images that remain', () => {
  it('references only files that exist in public/images/landing', () => {
    for (const image of Object.values(LANDING_IMAGES)) {
      for (const width of image.widths) {
        expect(existsSync(resolve(__dirname, '../../public', `.${landingSrc(image, width)}`))).toBe(
          true,
        );
      }
    }
  });
});

describe('the eval numbers', () => {
  const readme = read('README.md');
  const results: Record<string, string> = {
    planted: 'Planted conflicts surfaced at Gate 1',
    falseConflicts: 'Unexpected (false) conflicts',
    injectedFlagged: 'Injected claim defects flagged in the first audit',
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

describe('the /method boundaries', () => {
  it('backs each boundary and each data-handling statement with the code or rule it names', () => {
    expect(BOUNDARY_IDS).toHaveLength(9);
    const product = read('docs/product.md');
    for (const phrase of [
      'price valuations or investment advice',
      'interprets law',
      'screens, scores, or ranks buyers',
      'publishes to listing portals automatically',
      'hide defects or alter a property',
      'Standard mode only',
      'metadata/GPS stripped at upload',
      'faces and plates blurred in exports',
      'hard-deletes all materials and artifacts',
    ]) {
      expect(product, phrase).toContain(phrase);
    }
    expect(read('apps/api/src/media/image.ts')).toContain('no metadata');
    expect(read('apps/api/src/export/blur.ts')).toMatch(/faces\/people, license plates/);
    expect(read('apps/api/src/projects/projects.ts')).toContain('Hard-deletes the project');
    expect(read('apps/api/src/meta/clients.ts')).toContain('only Standard-mode models are allowed');
    expect(read('apps/api/src/pipeline/integrity/check.ts')).toContain('fallback_original');
  });

  it('does not claim EU hosting: the docs call it a target, not a fact', () => {
    // docs/product.md §9 says "Hosting is in the EU", but the README calls it the production
    // target and the architecture's own tests say nothing is deployed to check, so /method says
    // nothing about where it runs.
    expect(JSON.stringify(en.method)).not.toMatch(/\bEU\b|Europe|GDPR/);
  });
});
