import type {
  ClaimAuditStopReason,
  ChecklistItemStatus,
  FurnishingState,
  PhotoSubject,
  PrivacyStatus,
  RunStatus,
  StagingFailureReason,
  StagingOperationId,
  StagingSkipReason,
} from '@evidomo/shared';
import type { DecisionOrigin } from './decisions.ts';

// What the CLI reports about a run: printed for the operator and written as `summary.json`.
// IDs, keys, counts, categories, and exact decimal costs only: no copy text, flag problems, or
// fact values beyond what a scripted Gate 1 decision names.

export type PipelineMode = 'fixtures' | 'live' | 'record';

export interface StepSummary {
  readonly stepId: string;
  readonly status: 'not_started' | 'queued' | 'running' | 'completed' | 'failed';
  readonly attempts: number;
  readonly executions: number;
  readonly costUsd: string;
}

/** One project photo: what vision decided and what staging did with it. */
export interface PhotoSummary {
  readonly photo: string;
  /** Null when the classification failed. */
  readonly subject: PhotoSubject | null;
  readonly furnishing: FurnishingState | null;
  readonly coverRank: number | null;
  readonly privacy: PrivacyStatus;
  /** Null when the staging step stored no manifest (not reached or failed). */
  readonly staging: {
    readonly status: 'staged' | 'failed' | 'skipped';
    readonly operationId: StagingOperationId | null;
    readonly reason: StagingSkipReason | StagingFailureReason | null;
  } | null;
}

export interface PipelineSummary {
  readonly runId: string;
  readonly mode: PipelineMode;
  readonly cassette: string | null;
  readonly service: { readonly id: string; readonly version: number; readonly steps: string[] };
  readonly market: { readonly id: string; readonly version: number };
  readonly status: RunStatus;
  readonly failureReason: string | null;
  readonly durationMs: number;
  readonly steps: readonly StepSummary[];
  /** In inventory (upload) order; empty when the vision inventory was not stored. */
  readonly photos: readonly PhotoSummary[];
  readonly factConflicts: {
    readonly conflictCount: number;
    /** Every conflict at the gate, decided or not (`K01 energy_label`). */
    readonly conflicts: readonly string[];
    readonly decisions: readonly {
      readonly conflictId: string;
      readonly key: string;
      readonly decision: string;
      readonly origin: DecisionOrigin;
    }[];
  } | null;
  readonly claimAudit: {
    readonly stopReason: ClaimAuditStopReason | null;
    readonly passes: number;
    readonly flaggedClaims: number;
    readonly claims: readonly {
      readonly variant: string;
      readonly position: number;
      readonly flags: readonly string[];
      readonly choice: string;
      readonly origin: DecisionOrigin;
    }[];
    readonly images: readonly {
      readonly photo: string;
      readonly operationId: string;
      readonly choice: string;
      readonly origin: DecisionOrigin;
    }[];
    readonly integrityFallbacks: number;
    readonly warnings: readonly string[];
  } | null;
  readonly unusedDecisions: readonly string[];
  readonly export: {
    readonly outDir: string;
    readonly files: readonly { readonly fileName: string; readonly sizeBytes: number }[];
    readonly readyToPublish: boolean;
    readonly checklist: readonly {
      readonly id: string;
      readonly status: ChecklistItemStatus;
    }[];
    readonly withheld: number;
  } | null;
  readonly cost: {
    readonly runCostUsd: string;
    readonly runCapUsd: string;
    readonly calls: number;
    readonly byModel: readonly {
      readonly modelId: string;
      readonly calls: number;
      readonly costUsd: string;
    }[];
  };
  /** Fixture and record modes: what MSW saw. Null in live mode (no interception). */
  readonly network: {
    readonly liveRequests: number;
    readonly servedFromCassette: number;
    readonly unmatched: readonly string[];
    readonly unnamedImages: number;
  } | null;
}

/** `$0.1234` for display; the exact 8-digit value stays in `summary.json`. */
export function usd(value: string): string {
  return `$${Number(value).toFixed(4)}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

const ORIGIN_LABEL: Readonly<Record<DecisionOrigin, string>> = {
  decisions_file: 'decisions file',
  default_policy: 'default policy',
};

export function formatSummary(summary: PipelineSummary): string {
  const lines: string[] = [];
  const seconds = (summary.durationMs / 1000).toFixed(1);
  lines.push(
    `Run ${summary.runId}: ${summary.status} in ${seconds} s ` +
      `(mode ${summary.mode}${summary.cassette === null ? '' : `, cassette ${summary.cassette}`})`,
  );
  lines.push(
    `Service ${summary.service.id} v${summary.service.version}, market ${summary.market.id} ` +
      `v${summary.market.version}`,
  );
  if (summary.failureReason !== null) lines.push(`Failure: ${summary.failureReason}`);

  lines.push('', 'Steps');
  const width = Math.max(...summary.steps.map((s) => s.stepId.length), 4) + 2;
  for (const step of summary.steps) {
    const attempts =
      step.attempts === 0 ? '' : `  attempts ${step.attempts}, executions ${step.executions}`;
    lines.push(
      `  ${pad(step.stepId, width)}${pad(step.status, 12)}${pad(usd(step.costUsd), 10)}${attempts}`,
    );
  }

  lines.push('', 'Photos (vision, staging)');
  if (summary.photos.length === 0) lines.push('  no inventory');
  const nameWidth = Math.max(...summary.photos.map((p) => p.photo.length), 4) + 2;
  for (const p of summary.photos) {
    const classified =
      p.subject === null
        ? 'classification failed'
        : `${p.subject}, ${p.furnishing ?? 'furnishing n/a'}, rank ${String(p.coverRank)}`;
    const staging =
      p.staging === null
        ? 'staging n/a'
        : [p.staging.status, p.staging.operationId, p.staging.reason]
            .filter((part) => part !== null)
            .join(' ');
    lines.push(
      `  ${pad(p.photo, nameWidth)}${pad(classified, 40)}privacy ${p.privacy}; ${staging}`,
    );
  }

  lines.push('', 'Gate 1 (fact conflicts)');
  if (summary.factConflicts === null) {
    lines.push('  not reached');
  } else if (summary.factConflicts.conflictCount === 0) {
    lines.push('  no conflicts: released by reconciliation');
  } else {
    lines.push(
      `  ${summary.factConflicts.conflictCount} conflict(s): ${summary.factConflicts.conflicts.join(', ')}`,
    );
    for (const d of summary.factConflicts.decisions) {
      lines.push(`  ${d.conflictId} ${d.key}: ${d.decision} [${ORIGIN_LABEL[d.origin]}]`);
    }
  }

  lines.push('', 'Gate 2 (claim audit and staged images)');
  const gate2 = summary.claimAudit;
  if (gate2 === null) {
    lines.push('  not reached');
  } else {
    lines.push(
      `  audit: ${gate2.passes} pass(es), stop reason ${gate2.stopReason ?? 'none'}, ` +
        `${gate2.flaggedClaims} flagged claim(s)`,
    );
    for (const c of gate2.claims) {
      lines.push(
        `  claim ${c.variant}:${c.position} [${c.flags.join(', ')}] -> ${c.choice} [${ORIGIN_LABEL[c.origin]}]`,
      );
    }
    for (const i of gate2.images) {
      lines.push(
        `  image ${i.photo} (${i.operationId}) -> ${i.choice} [${ORIGIN_LABEL[i.origin]}]`,
      );
    }
    if (gate2.integrityFallbacks > 0) {
      lines.push(`  ${gate2.integrityFallbacks} staged photo(s) rejected by the integrity check`);
    }
    if (gate2.warnings.length > 0) lines.push(`  warnings: ${gate2.warnings.join('; ')}`);
  }
  for (const unused of summary.unusedDecisions) lines.push(`  unused decision: ${unused}`);

  lines.push('', 'Export');
  if (summary.export === null) {
    lines.push('  not produced');
  } else {
    lines.push(`  ${summary.export.files.length} files written to ${summary.export.outDir}`);
    lines.push(`  readyToPublish: ${summary.export.readyToPublish}`);
    for (const item of summary.export.checklist)
      lines.push(`  checklist ${item.id}: ${item.status}`);
    if (summary.export.withheld > 0) lines.push(`  withheld images: ${summary.export.withheld}`);
  }

  lines.push('', 'Cost (usage ledger)');
  lines.push(
    `  ${usd(summary.cost.runCostUsd)} for ${summary.cost.calls} model call(s), run cap ` +
      `${usd(summary.cost.runCapUsd)}${summary.mode === 'fixtures' ? ' (replayed usage: nothing billed)' : ''}`,
  );
  for (const m of summary.cost.byModel) {
    lines.push(`  ${pad(m.modelId, 28)}${pad(String(m.calls), 6)}${usd(m.costUsd)}`);
  }
  if (summary.network !== null) {
    lines.push('', 'Network');
    lines.push(
      `  live requests: ${summary.network.liveRequests}, served from cassette: ` +
        `${summary.network.servedFromCassette}, unmatched: ${summary.network.unmatched.length}`,
    );
    if (summary.network.unnamedImages > 0) {
      lines.push(
        `  warning: ${summary.network.unnamedImages} image(s) were keyed by their bytes, so this ` +
          'cassette may not replay on another CPU architecture',
      );
    }
    for (const message of summary.network.unmatched) lines.push(`  ${message}`);
  }
  return lines.join('\n');
}
