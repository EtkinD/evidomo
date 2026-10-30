import type { EvalReport, SetRun } from './run.ts';
import type { Rate } from './score.ts';

// The eval's terminal table and Markdown report (docs/architecture.md §12). Model wording never
// appears here: only IDs, counts, categories, and costs.

function percent(r: Rate): string {
  return r.rate === null ? 'n/a' : `${r.hit}/${r.total} (${Math.round(r.rate * 100)}%)`;
}

function usd(value: number): string {
  return value.toFixed(4);
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

function setRow(set: SetRun): string[] {
  const s = set.score;
  const planted = s.conflicts.filter((c) => c.origin === 'planted');
  const incidental = s.conflicts.filter((c) => c.origin === 'incidental');
  const applied = s.injections.filter((i) => i.status === 'applied');
  const count = (list: readonly { caught: boolean }[]) =>
    `${list.filter((c) => c.caught).length}/${list.length}`;
  return [
    set.id,
    set.status,
    count(planted),
    count(incidental),
    String(s.unexpectedConflicts.length),
    `${s.basisNotes.filter((b) => b.found).length}/${s.basisNotes.length}`,
    `${applied.filter((i) => i.detected).length}/${applied.length}` +
      (applied.length === s.injections.length ? '' : ` (of ${s.injections.length})`),
    String(applied.filter((i) => i.final === 'unflagged').length),
    String(applied.filter((i) => i.exported === true).length),
    `${s.otherInitialFlags.validator}/${s.otherInitialFlags.verifier}`,
    set.passes === null ? '-' : `${set.passes} ${set.stopReason ?? ''}`.trim(),
    Number(set.usage.runCostUsd).toFixed(4),
    String(set.usage.calls),
    usd(set.liveSpendUsd),
    set.liveCalls === 0 ? '-' : `${set.liveCalls}/${set.network.liveRequests}`,
    set.liveCalls === 0 ? '-' : (set.liveLatencyMs / 1000).toFixed(0),
  ];
}

const SET_HEADER = [
  'set',
  'status',
  'planted',
  'incidental',
  'unexpected',
  'basis notes',
  'injected caught',
  'unflagged at G2',
  'exported',
  'other flags v/V',
  'passes',
  'cost USD',
  'calls',
  'live USD',
  'live calls/req',
  'live s',
] as const;

function injectionRows(report: EvalReport): string[][] {
  return report.sets.flatMap((set) =>
    set.score.injections.map((i) => [
      set.id,
      i.id,
      i.variant,
      `${i.expectedDetector}/${i.expectedCategory}`,
      i.status === 'applied' ? (i.detected ? 'caught' : 'MISSED') : i.status,
      i.detectedBy.join('+') || '-',
      i.status !== 'applied' ? '-' : i.categoryMatched ? 'yes' : 'no',
      i.final ?? '-',
      i.exported === null ? '-' : i.exported ? 'LEAKED' : 'no',
    ]),
  );
}

function conflictRows(report: EvalReport): string[][] {
  return report.sets.flatMap((set) => [
    ...set.score.conflicts.map((c) => [
      set.id,
      c.id,
      c.origin,
      c.decidedBy,
      c.caught ? `caught (${c.conflictIds.join(', ')})` : 'MISSED',
    ]),
    ...set.score.unexpectedConflicts.map((c) => [
      set.id,
      c.key,
      'unexpected',
      c.detectedBy.join('+'),
      c.id,
    ]),
  ]);
}

/** Gate 1 as each run showed it; the fact values are the synthetic sets' own. */
function gateRows(report: EvalReport): string[][] {
  return report.sets.flatMap((set) =>
    set.conflicts.map((c) => [
      set.id,
      c.id,
      c.key,
      c.detectedBy.join('+'),
      c.sides.map((side) => side.join(', ')).join(' vs '),
    ]),
  );
}

function otherFlagRows(report: EvalReport): string[][] {
  return report.sets.flatMap((set) =>
    set.score.otherFlags.map((f) => [
      set.id,
      `${f.variant} ${f.segmentIndex}`,
      f.source,
      f.category,
      f.code ?? '-',
    ]),
  );
}

function temptationRows(report: EvalReport): string[][] {
  return report.sets.flatMap((set) =>
    set.score.temptations.map((t) => [
      set.id,
      t.id,
      t.category,
      String(t.appeared),
      String(t.flagged),
      String(t.unflaggedInFinal),
      t.exported === null ? '-' : t.exported ? 'yes' : 'no',
    ]),
  );
}

const OTHER_FLAG_HEADER = ['set', 'segment', 'source', 'category', 'code'] as const;
const TEMPTATION_HEADER = [
  'set',
  'temptation',
  'category',
  'appeared',
  'flagged',
  'unflagged at G2',
  'exported',
] as const;
const GATE_HEADER = ['set', 'conflict', 'key', 'detected by', 'sides'] as const;

function totalsLines(report: EvalReport): string[] {
  const t = report.totals;
  return [
    `Planted conflicts surfaced at Gate 1: ${percent(t.plantedConflicts)} ` +
      `(decided by code ${percent(t.plantedByCode)}, by the model ${percent(t.plantedByModel)})`,
    `Incidental conflicts (true contradictions of the base inputs): ${percent(t.incidentalConflicts)}`,
    `Unexpected conflicts (in no answer key): ${t.unexpectedConflicts}`,
    `Basis notes on the fact sheet: ${percent(t.basisNotes)}`,
    `Injected claim defects present in the first draft: ${percent(t.injectionsApplied)}`,
    `Injected defects flagged in the first audit: ${percent(t.injectionsDetected)} ` +
      `(validator-expected ${percent(t.injectionsByValidatorExpected)}, ` +
      `verifier-expected ${percent(t.injectionsByVerifierExpected)}; ` +
      `with the expected category ${percent(t.injectionsCategoryMatched)})`,
    `Injected defects at Gate 2 still in the text and unflagged: ${t.injectionsUnflaggedAtGate2}`,
    `Injected defects in an exported pack: ${t.injectionsExported}`,
    `First-audit flags on uninjected segments: validator ${t.otherInitialFlags.validator}, ` +
      `verifier ${t.otherInitialFlags.verifier}`,
    `Validator rejections: ${t.validatorFlagsInitial} in first drafts, ` +
      `${t.validatorFlagsRemaining} at Gate 2`,
    `Tempted phrases in first drafts: ${t.temptationsAppeared} (flagged ${t.temptationsFlagged})`,
  ];
}

function header(report: EvalReport): string[] {
  return [
    `Mode: ${report.mode}; ${report.sets.length} set(s); ${(report.durationMs / 1000).toFixed(0)} s`,
    report.mode === 'fixtures'
      ? 'Live requests: 0 (replayed); cost = the ledger of the recorded responses, as if live'
      : `Live spend: ${usd(report.liveSpendUsd)} USD (cap ${report.maxUsd ?? '-'})`,
    ...(report.skippedForBudget.length === 0
      ? []
      : [`Skipped for the budget: ${report.skippedForBudget.join(', ')}`]),
  ];
}

export function formatEvalReport(report: EvalReport): string {
  return [
    ...header(report),
    '',
    ...table(SET_HEADER, report.sets.map(setRow)),
    '',
    ...totalsLines(report),
    '',
    ...table(['set', 'conflict', 'origin', 'decided by', 'result'], conflictRows(report)),
    '',
    ...table(
      ['set', 'injection', 'variant', 'expected', 'pass 0', 'by', 'category', 'Gate 2', 'export'],
      injectionRows(report),
    ),
    '',
    ...table(OTHER_FLAG_HEADER, otherFlagRows(report)),
    ...(temptationRows(report).length === 0
      ? []
      : ['', ...table(TEMPTATION_HEADER, temptationRows(report))]),
    ...report.sets
      .filter((s) => s.failureReason !== null || s.network.unmatched.length > 0)
      .map((s) =>
        `\n${s.id}: ${s.failureReason ?? ''} ${s.network.unmatched.join('; ')}`.trimEnd(),
      ),
  ].join('\n');
}

export function evalReportMarkdown(report: EvalReport): string {
  return [
    '# Seeded-defect eval',
    '',
    ...header(report).map((line) => `- ${line}`),
    '',
    '## Sets',
    '',
    ...table(SET_HEADER, report.sets.map(setRow)),
    '',
    '## Totals',
    '',
    ...totalsLines(report).map((line) => `- ${line}`),
    '',
    '## Conflicts',
    '',
    ...table(['set', 'conflict', 'origin', 'decided by', 'result'], conflictRows(report)),
    '',
    '## Injected claim defects',
    '',
    ...table(
      ['set', 'injection', 'variant', 'expected', 'pass 0', 'by', 'category', 'Gate 2', 'export'],
      injectionRows(report),
    ),
    '',
    '## First-audit flags on uninjected segments',
    '',
    ...table(OTHER_FLAG_HEADER, otherFlagRows(report)),
    '',
    '## Tempted phrases',
    '',
    ...table(TEMPTATION_HEADER, temptationRows(report)),
    '',
    '## Gate 1 as shown',
    '',
    ...table(GATE_HEADER, gateRows(report)),
    '',
  ].join('\n');
}
