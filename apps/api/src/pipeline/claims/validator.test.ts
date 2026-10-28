import { randomUUID } from 'node:crypto';
import { claimValidationReportSchema, type ClaimFindingCode } from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import type { Fact, NewFact } from '../../db/repositories/facts.ts';
import { storedFact } from '../reconciliation/testing.ts';
import type { ClaimLanguage } from './numbers.ts';
import { validateClaims, findingsForSegment, type ClaimFact } from './validator.ts';

// The claim validator's pass and fail cases in English and Dutch over a fictional run's facts.
// The facts are stored-fact rows (what the creative step passes), keyed by a short name here.

const MATERIAL = randomUUID();
const transcript = {
  kind: 'transcript_turn' as const,
  transcriptArtifactId: randomUUID(),
  turnIndex: 0,
  startMs: 0,
  endMs: 1000,
  quote: 'a quote',
};
const photo = {
  kind: 'photo_region' as const,
  materialId: MATERIAL,
  region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
};
const form = (field: string) => ({ kind: 'form' as const, field });

const verified = (fact: Omit<NewFact, 'stepId' | 'status'>): NewFact => ({
  stepId: 'reconciliation',
  status: 'verified',
  ...fact,
});

const FACTS = {
  area: verified({
    key: 'living_area',
    value: 92,
    unit: 'm2',
    basis: 'NEN2580',
    source: form('living_area'),
  }),
  areaSpoken: verified({
    key: 'living_area',
    value: 92,
    unit: 'm2',
    basis: 'NEN2580',
    source: transcript,
  }),
  label: verified({ key: 'energy_label', value: 'A++', source: form('energy_label') }),
  year: verified({ key: 'build_year', value: 1987, source: form('build_year') }),
  vve: verified({ key: 'vve_monthly_contribution', value: 165, unit: 'EUR', source: form('vve') }),
  floor: verified({ key: 'other:floor_level', value: 2, source: transcript }),
  rooms: verified({ key: 'other:number_of_rooms', value: 3, source: transcript }),
  cycling: verified({ key: 'other:station_cycling_time_minutes', value: 10, source: transcript }),
  balcony: verified({
    key: 'other:balcony_area',
    value: 7,
    unit: 'm2',
    basis: 'unspecified',
    source: transcript,
  }),
  ceiling: verified({ key: 'other:ceiling_height', value: 2.6, unit: 'm', source: transcript }),
  plot: verified({
    key: 'plot_area',
    value: 94.6,
    unit: 'm2',
    basis: 'cadastral',
    source: form('plot_area'),
  }),
  price: verified({ key: 'other:asking_price', value: 1_250_000, unit: 'EUR', source: transcript }),
  solar: verified({ key: 'other:solar_coverage', value: 40, unit: '%', source: transcript }),
  parking: verified({ key: 'other:parking', value: '2 parking spaces', source: transcript }),
  handover: verified({ key: 'other:handover_date', value: '12-03-2027', source: transcript }),
  renovated: verified({ key: 'other:renovation_year', value: 2021, source: transcript }),
  ground: verified({ key: 'ground_lease', value: false, source: form('ground_lease') }),
  floorGate: verified({
    key: 'other:bedroom_floor',
    value: 'carpet',
    source: {
      kind: 'gate_decision',
      gate: 'fact_conflicts',
      conflictsArtifactId: randomUUID(),
      conflictId: 'K01',
    },
  }),
  radiators: verified({ key: 'other:radiator', value: 2, source: photo }),
  areaRejected: {
    stepId: 'extraction',
    key: 'living_area',
    value: 95,
    unit: 'm2',
    basis: null,
    source: transcript,
    status: 'rejected',
  },
  candidate: {
    stepId: 'extraction',
    key: 'other:garden_area',
    value: 40,
    unit: 'm2',
    source: transcript,
    status: 'candidate',
  },
  opinion: {
    stepId: 'extraction',
    key: 'other:neighbourhood',
    value: 'the nicest street in town',
    source: transcript,
    status: 'candidate',
    assertion: 'opinion',
  },
} satisfies Record<string, NewFact>;
type FactName = keyof typeof FACTS;

const STORED: ReadonlyMap<string, Fact> = new Map(
  Object.entries(FACTS).map(([name, fact]) => [name, storedFact('run', fact)]),
);
const ALL: ClaimFact[] = [...STORED.values()];

/** The stored ID of a named fact. */
function id(name: FactName): string {
  const fact = STORED.get(name);
  if (fact === undefined) throw new Error(`No fact ${name}`);
  return fact.id;
}

/** Findings for one segment as `[code, token]` pairs. */
function check(
  language: ClaimLanguage,
  text: string,
  cited: readonly FactName[],
): [ClaimFindingCode, string | null][] {
  const report = validateClaims({
    language,
    segments: [{ variant: 'portal', segmentIndex: 0, text, factIds: cited.map(id) }],
    facts: ALL,
  });
  return report.findings.map((finding) => [finding.code, finding.token]);
}

describe('citations', () => {
  it('rejects a segment that cites nothing', () => {
    expect(check('en', 'A bright home.', [])).toEqual([['missing_fact_ids', null]]);
  });

  it('rejects an ID that is not a fact of this run, also next to a valid one', () => {
    const report = validateClaims({
      language: 'en',
      segments: [
        {
          variant: 'portal',
          segmentIndex: 0,
          text: 'A home of 92 m².',
          factIds: [id('area'), randomUUID()],
        },
        { variant: 'portal', segmentIndex: 1, text: 'A home.', factIds: ['VF01'] },
        { variant: 'portal', segmentIndex: 2, text: 'A home.', factIds: [''] },
      ],
      facts: ALL,
    });
    expect(report.findings.map((f) => [f.segmentIndex, f.code])).toEqual([
      [0, 'unknown_fact_id'],
      [1, 'unknown_fact_id'],
      [2, 'unknown_fact_id'],
    ]);
    expect(report.findings[1]?.factId).toBe('VF01');
    expect(report.findings[2]?.factId).toBeNull();
  });

  it('rejects facts that are not verified, and opinions', () => {
    expect(check('en', 'A home.', ['areaRejected'])).toEqual([['unverified_fact', null]]);
    expect(check('en', 'A home.', ['candidate'])).toEqual([['unverified_fact', null]]);
    expect(check('en', 'On the nicest street.', ['opinion'])).toEqual([['opinion_cited', null]]);
  });

  it('treats a fact missing from the given facts as unknown (callers may pass verified facts only)', () => {
    const report = validateClaims({
      language: 'en',
      segments: [
        { variant: 'qa', segmentIndex: 4, text: 'A home.', factIds: [id('areaRejected')] },
      ],
      facts: ALL.filter((fact) => fact.status === 'verified'),
    });
    expect(report.findings.map((f) => [f.variant, f.segmentIndex, f.code, f.factId])).toEqual([
      ['qa', 4, 'unknown_fact_id', id('areaRejected')],
    ]);
  });

  it('accepts Gate 1 decisions and facts without numbers', () => {
    expect(check('en', 'The bedroom has carpet.', ['floorGate'])).toEqual([]);
    expect(check('nl', 'Grond niet in erfpacht.', ['ground'])).toEqual([]);
    expect(check('en', 'Energy label A++.', ['label'])).toEqual([]);
  });

  it('does not let an invalid citation support a number', () => {
    expect(check('en', 'A home of 95 m².', ['areaRejected'])).toEqual([
      ['unverified_fact', null],
      ['number_not_in_facts', '95 m²'],
    ]);
  });
});

describe('numbers that match a cited fact exactly', () => {
  it.each<[ClaimLanguage, string, FactName[]]>([
    ['en', 'This apartment offers 92 m² of living space.', ['area']],
    ['en', 'Living area 92 m2, measured to NEN 2580.', ['area']],
    ['en', 'A home of 92 square metres.', ['area', 'areaSpoken']],
    ['en', 'Living space: 92.', ['area']],
    ['en', 'Built in 1987.', ['year']],
    ['en', 'The VvE contribution is €165 per month.', ['vve']],
    ['en', 'The VvE contribution is EUR 165.00 a month.', ['vve']],
    ['en', 'It sits on floor 2.', ['floor']],
    ['en', 'It sits on the 2nd floor.', ['floor']],
    ['en', 'It sits on the second floor.', ['floor']],
    ['en', 'It has three rooms.', ['rooms']],
    ['en', 'The station is 10 minutes by bike.', ['cycling']],
    ['en', 'Asking price €1,250,000.', ['price']],
    ['en', 'Ceilings are 2.6 m high.', ['ceiling']],
    ['en', 'The plot is 94.6 m².', ['plot']],
    ['en', 'Solar panels cover 40% of the demand.', ['solar']],
    ['en', 'It comes with two parking spaces.', ['parking']],
    ['en', 'Handover on 12-03-2027.', ['handover']],
    ['en', 'A 7 m² balcony and 92 m² of living space.', ['balcony', 'area']],
    ['en', 'The kitchen from 2021 and the bathroom from 2021.', ['renovated']],
    ['en', 'One of the bedrooms has carpet.', ['floorGate']],
    ['nl', 'Woonoppervlakte 92 m² (NEN 2580).', ['area']],
    ['nl', 'Woonoppervlakte 92 vierkante meter.', ['area']],
    ['nl', 'Bouwjaar 1987 met 3 kamers.', ['year', 'rooms']],
    ['nl', 'VvE-bijdrage €165 per maand.', ['vve']],
    ['nl', 'VvE-bijdrage € 165,- per maand.', ['vve']],
    ['nl', 'Gelegen op de 2e verdieping.', ['floor']],
    ['nl', 'Gelegen op de tweede verdieping.', ['floor']],
    ['nl', 'Drie kamers.', ['rooms']],
    ['nl', 'Station op 10 minuten fietsen.', ['cycling']],
    ['nl', 'Vraagprijs € 1.250.000,- k.k.', ['price']],
    ['nl', 'Plafondhoogte 2,6 meter.', ['ceiling']],
    ['nl', 'Perceel 94,6 m².', ['plot']],
    ['nl', 'Zonnepanelen dekken 40 procent.', ['solar']],
    ['nl', 'Een 2-onder-1-kapwoning van 92 m².', ['area']],
    ['nl', 'Energielabel A++.', ['label']],
  ])('%s: %s', (language, text, cited) => {
    expect(check(language, text, cited)).toEqual([]);
  });
});

describe('numbers that do not match', () => {
  it.each<[ClaimLanguage, string, FactName[], [ClaimFindingCode, string | null][]]>([
    // A different value, with no rounding: 95 is not 94.6, 92.5 is not 92.
    ['en', 'A home of 95 m².', ['area'], [['number_not_in_facts', '95 m²']]],
    ['en', 'The plot is 95 m².', ['plot'], [['number_not_in_facts', '95 m²']]],
    ['nl', 'Woonoppervlakte 92,5 m².', ['area'], [['number_not_in_facts', '92,5 m²']]],
    ['en', 'Built in 2021.', ['year'], [['number_not_in_facts', '2021']]],
    // A number from a fact the segment does not cite.
    ['en', 'Built in 1987, 92 m².', ['area'], [['number_not_in_facts', '1987']]],
    // Separators of the other language.
    ['en', 'The plot is 94,6 m².', ['plot'], [['unreadable_number', '94,6 m²']]],
    ['nl', 'Plafondhoogte 2.6 meter.', ['ceiling'], [['unreadable_number', '2.6 meter']]],
    ['en', 'Asking price €1.250.000.', ['price'], [['unreadable_number', '€1.250.000']]],
    // English "1.250" is 1.25, never 1250.
    ['en', 'Asking price €1.250.', ['price'], [['number_not_in_facts', '€1.250']]],
    ['en', 'Asking price €1.25 million.', ['price'], [['unreadable_number', '€1.25 million']]],
    ['nl', 'Vraagprijs € 1,25 miljoen.', ['price'], [['unreadable_number', '€ 1,25 miljoen']]],
    ['en', 'Asking price €1250k.', ['price'], [['unreadable_number', '€1250k']]],
    // Number words and ordinals are number claims too.
    ['en', 'It has two bedrooms.', ['rooms'], [['number_not_in_facts', 'two']]],
    ['nl', 'Met drie slaapkamers.', ['floor'], [['number_not_in_facts', 'drie']]],
    ['en', 'French doors as a pair.', ['area'], [['number_not_in_facts', 'pair']]],
    ['en', 'It sits on the first floor.', ['floor'], [['number_not_in_facts', 'first']]],
    ['en', 'It sits on the 1st floor.', ['floor'], [['number_not_in_facts', '1st']]],
    ['nl', 'Gelegen op de eerste verdieping.', ['floor'], [['number_not_in_facts', 'eerste']]],
    ['nl', 'Gelegen op de 3e verdieping.', ['floor'], [['number_not_in_facts', '3e']]],
    // Dates and times must appear in a cited fact.
    ['en', 'Handover on 13-03-2027.', ['handover'], [['number_not_in_facts', '13-03-2027']]],
    ['nl', 'Bezichtiging om 10:30.', ['area'], [['number_not_in_facts', '10:30']]],
    // A repeated number is one finding.
    [
      'en',
      'Kitchen from 2020, bathroom from 2020.',
      ['renovated'],
      [['number_not_in_facts', '2020']],
    ],
  ])('%s: %s', (language, text, cited, expected) => {
    expect(check(language, text, cited)).toEqual(expected);
  });
});

describe('units', () => {
  it.each<[ClaimLanguage, string, FactName[], string]>([
    ['en', 'A home of 92 m.', ['area'], '92 m'],
    ['en', 'A home of 92 m³.', ['area'], '92 m³'],
    ['en', 'A home of €92.', ['area'], '€92'],
    ['en', 'The VvE contribution is 165 m².', ['vve'], '165 m²'],
    ['nl', 'Station op 10 km.', ['cycling'], '10 km'],
    ['nl', 'Bouwjaar 1987 m².', ['year'], '1987 m²'],
    ['en', 'Solar panels cover 40 m².', ['solar'], '40 m²'],
    ['en', '3 m² of rooms.', ['rooms'], '3 m²'],
  ])('%s: %s is a unit mismatch', (language, text, cited, token) => {
    expect(check(language, text, cited)).toEqual([['unit_mismatch', token]]);
  });

  it('names the fact behind a unit mismatch and its unit, never the segment text', () => {
    const report = validateClaims({
      language: 'en',
      segments: [
        {
          variant: 'social',
          segmentIndex: 7,
          text: 'Sunny Zandmeer flat, 92 m³ inside.',
          factIds: [id('area')],
        },
      ],
      facts: ALL,
    });
    expect(report.findings).toEqual([
      {
        variant: 'social',
        segmentIndex: 7,
        code: 'unit_mismatch',
        token: '92 m³',
        factId: id('area'),
        detail: '"92 m³": the unit does not match the cited fact (m2).',
      },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/Zandmeer|Sunny|inside/);
  });
});

describe('photo facts are presence evidence only', () => {
  it('never supports a number, even one equal to the per-photo count', () => {
    expect(check('en', 'There are 2 radiators.', ['radiators'])).toEqual([
      ['number_from_photo', '2'],
    ]);
    expect(check('en', 'There are two radiators.', ['radiators'])).toEqual([
      ['number_from_photo', 'two'],
    ]);
    expect(check('nl', 'Zes radiatoren en 92 m².', ['radiators', 'area'])).toEqual([
      ['number_from_photo', 'Zes'],
    ]);
  });

  it('supports a presence without a number', () => {
    expect(check('en', 'The rooms have radiators.', ['radiators'])).toEqual([]);
  });
});

describe('approximations and ranges', () => {
  it.each<[ClaimLanguage, string, FactName[], [ClaimFindingCode, string | null][]]>([
    // Softening an exact fact is flagged even when the number matches.
    ['en', 'About 92 m² of living space.', ['area'], [['approximate_number', 'About 92 m²']]],
    ['en', 'Some 92 m² of living space.', ['area'], [['approximate_number', 'Some 92 m²']]],
    ['en', 'A home of 92+ m².', ['area'], [['approximate_number', '92+']]],
    ['en', 'A VvE contribution of around €165.', ['vve'], [['approximate_number', 'around €165']]],
    ['nl', 'Ca. 92 m² woonoppervlakte.', ['area'], [['approximate_number', 'Ca. 92 m²']]],
    ['nl', 'Ruim 92 m² woonoppervlakte.', ['area'], [['approximate_number', 'Ruim 92 m²']]],
    ['nl', 'Ongeveer drie kamers.', ['rooms'], [['approximate_number', 'Ongeveer drie']]],
    [
      'nl',
      "Zo'n 95 m² woonoppervlakte.",
      ['area'],
      [
        ['number_not_in_facts', '95 m²'],
        ['approximate_number', "Zo'n 95 m²"],
      ],
    ],
    [
      'en',
      'More than 90 m² of living space.',
      ['area'],
      [
        ['number_not_in_facts', '90 m²'],
        ['approximate_number', 'More than 90 m²'],
      ],
    ],
    [
      'en',
      'Between 92 and 95 m².',
      ['area'],
      [
        ['number_range', '92 and 95 m²'],
        ['number_not_in_facts', '95 m²'],
      ],
    ],
    [
      'nl',
      'Woonoppervlakte 90-95 m².',
      ['area'],
      [
        ['number_not_in_facts', '90'],
        ['number_range', '90-95 m²'],
        ['number_not_in_facts', '95 m²'],
      ],
    ],
    [
      'nl',
      'Twee à drie kamers.',
      ['rooms'],
      [
        ['number_not_in_facts', 'Twee'],
        ['number_range', 'Twee à drie'],
      ],
    ],
  ])('%s: %s', (language, text, cited, expected) => {
    expect(check(language, text, cited)).toEqual(expected);
  });
});

describe('report', () => {
  it('reports per segment, in order, with counts and a pass/fail summary', () => {
    const report = validateClaims({
      language: 'en',
      segments: [
        { variant: 'portal', segmentIndex: 0, text: 'A home of 92 m².', factIds: [id('area')] },
        {
          variant: 'portal',
          segmentIndex: 1,
          text: 'Built in 1988, about 92 m².',
          factIds: [id('area')],
        },
        { variant: 'social', segmentIndex: 2, text: 'A bright home.', factIds: [] },
      ],
      facts: ALL,
    });
    expect(claimValidationReportSchema.parse(report)).toEqual(report);
    expect(report).toMatchObject({
      rulesVersion: 1,
      language: 'en',
      result: 'fail',
      counts: { segments: 3, failedSegments: 2, numbers: 3, findings: 3 },
    });
    expect(report.findings.map((f) => [f.variant, f.segmentIndex, f.code])).toEqual([
      ['portal', 1, 'number_not_in_facts'],
      ['portal', 1, 'approximate_number'],
      ['social', 2, 'missing_fact_ids'],
    ]);
    expect(findingsForSegment(report, 'portal', 0)).toEqual([]);
    expect(findingsForSegment(report, 'portal', 1)).toHaveLength(2);
    for (const finding of report.findings) expect(finding.detail.length).toBeLessThanOrEqual(300);
  });

  it('passes when every segment passes, including an empty input', () => {
    const report = validateClaims({ language: 'nl', segments: [], facts: ALL });
    expect(report).toMatchObject({ result: 'pass', counts: { segments: 0, findings: 0 } });
  });

  it('caps a long token and a long unknown ID', () => {
    const report = validateClaims({
      language: 'en',
      segments: [
        {
          variant: 'portal',
          segmentIndex: 0,
          text: `Code ${'1'.repeat(80)}.`,
          factIds: ['x'.repeat(200)],
        },
      ],
      facts: ALL,
    });
    expect(
      report.findings.map((f) => [f.code, f.token?.length ?? null, f.factId?.length ?? null]),
    ).toEqual([
      ['unknown_fact_id', null, 64],
      ['number_not_in_facts', 60, null],
    ]);
  });
});
