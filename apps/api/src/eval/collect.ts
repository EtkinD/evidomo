import {
  CLAIM_AUDIT_ARTIFACT_KIND,
  claimAuditContentSchema,
  EXPORT_PORTAL_FIELDS_ARTIFACT_KIND,
  type GateConflict,
  LISTING_COPY_ARTIFACT_KIND,
  listingCopyContentSchema,
  portalFieldsSchema,
  QA_CARDS_ARTIFACT_KIND,
  qaCardsContentSchema,
  VERIFIED_FACT_SHEET_ARTIFACT_KIND,
  verifiedFactSheetContentSchema,
  type ClaimAuditFlag,
} from '@evidomo/shared';
import type { Database } from '../db/client.ts';
import { listArtifacts } from '../db/repositories/artifacts.ts';
import { listRunSteps } from '../db/repositories/run-steps.ts';
import { getRunCostUsd, listUsageForRun } from '../db/repositories/usage.ts';
import { readAll } from '../pipeline/vision/handler.ts';
import type { Storage } from '../storage/storage.ts';
import type {
  ObservedBasisNote,
  ObservedClaims,
  ObservedConflict,
  ObservedDraft,
  ObservedFlag,
  ObservedSegment,
} from './score.ts';

// Reads what one eval run stored into the plain shapes `score.ts` compares with the answer key.

const MAX_PORTAL_FIELDS_BYTES = 16 * 1024 * 1024;

export function observedConflicts(conflicts: readonly GateConflict[]): ObservedConflict[] {
  return conflicts.map((c) => ({
    id: c.id,
    key: c.key,
    detectedBy: [...c.detectedBy],
    sides: c.sides.map((side) => ({
      facts: side.facts.map((fact) => ({
        key: fact.key,
        value: fact.value,
        source:
          fact.source.kind === 'form'
            ? { kind: 'form', field: fact.source.field }
            : { kind: fact.source.kind },
      })),
    })),
  }));
}

export async function observedBasisNotes(
  db: Database,
  runId: string,
): Promise<ObservedBasisNote[]> {
  const [sheet] = await listArtifacts(db, runId, { kind: VERIFIED_FACT_SHEET_ARTIFACT_KIND });
  if (sheet === undefined) return [];
  return verifiedFactSheetContentSchema
    .parse(sheet.content)
    .basisNotes.map((note) => ({ key: note.key, value: note.value }));
}

function toFlag(flag: ClaimAuditFlag): ObservedFlag {
  return {
    variant: flag.variant,
    segmentIndex: flag.segmentIndex,
    source: flag.source,
    category: flag.category,
    code: flag.code,
  };
}

async function draftSegments(
  db: Database,
  runId: string,
  copyId: string,
  qaId: string | null,
): Promise<ObservedSegment[]> {
  const copies = await listArtifacts(db, runId, { kind: LISTING_COPY_ARTIFACT_KIND });
  const copyRow = copies.find((row) => row.id === copyId);
  if (copyRow === undefined) throw new Error(`Run ${runId} has no listing_copy ${copyId}`);
  const copy = listingCopyContentSchema.parse(copyRow.content);
  const segments: ObservedSegment[] = copy.variants.flatMap((variant) =>
    variant.segments.map((s) => ({ variant: variant.kind, segmentIndex: s.index, text: s.text })),
  );
  if (qaId !== null) {
    const cards = await listArtifacts(db, runId, { kind: QA_CARDS_ARTIFACT_KIND });
    const qaRow = cards.find((row) => row.id === qaId);
    if (qaRow === undefined) throw new Error(`Run ${runId} has no qa_cards ${qaId}`);
    const qa = qaCardsContentSchema.parse(qaRow.content);
    for (const card of qa.cards) {
      for (const s of card.segments) {
        segments.push({ variant: 'qa', segmentIndex: s.index, text: s.text });
      }
    }
  }
  return segments;
}

async function exportedTexts(
  db: Database,
  storage: Storage,
  runId: string,
): Promise<string[] | null> {
  const [fieldsArtifact] = await listArtifacts(db, runId, {
    kind: EXPORT_PORTAL_FIELDS_ARTIFACT_KIND,
  });
  if (fieldsArtifact?.storageKey === undefined || fieldsArtifact.storageKey === null) return null;
  const bytes = await readAll(
    await storage.get(fieldsArtifact.storageKey),
    MAX_PORTAL_FIELDS_BYTES,
  );
  const fields = portalFieldsSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  return [
    fields.copy.portal.text,
    fields.copy.social.text,
    ...fields.qaCards.flatMap((card) => [card.question, card.answer]),
  ];
}

/** The claim audit's first and last pass with their drafts; null before verification ran. */
export async function observedClaims(
  db: Database,
  storage: Storage,
  runId: string,
): Promise<ObservedClaims | null> {
  const [auditRow] = await listArtifacts(db, runId, { kind: CLAIM_AUDIT_ARTIFACT_KIND });
  if (auditRow === undefined) return null;
  const audit = claimAuditContentSchema.parse(auditRow.content);
  const first = audit.passes[0];
  const last = audit.passes.at(-1);
  if (first === undefined || last === undefined) throw new Error('A claim audit without passes');
  const draft = async (pass: typeof first): Promise<ObservedDraft> => ({
    segments: await draftSegments(db, runId, pass.draftArtifactId, pass.qaDraftArtifactId),
    flags: pass.flags.map(toFlag),
  });
  return {
    initial: await draft(first),
    final: await draft(last),
    passes: audit.passes.length,
    stopReason: audit.stopReason,
    exported: await exportedTexts(db, storage, runId),
  };
}

export interface StepCost {
  readonly stepId: string;
  readonly calls: number;
  readonly costUsd: number;
  readonly latencyMs: number;
}

export interface RunUsage {
  /** Exact decimal from the ledger. */
  readonly runCostUsd: string;
  readonly calls: number;
  /** Sum of the calls' wall-clock times (replayed calls take milliseconds). */
  readonly latencyMs: number;
  readonly steps: readonly StepCost[];
}

export async function runUsage(db: Database, runId: string): Promise<RunUsage> {
  const usage = await listUsageForRun(db, runId);
  const order = (await listRunSteps(db, runId)).map((row) => row.stepId);
  const stepIds = [...new Set([...order, ...usage.map((u) => u.stepId ?? '(none)')])];
  return {
    runCostUsd: await getRunCostUsd(db, runId),
    calls: usage.length,
    latencyMs: usage.reduce((sum, u) => sum + u.latencyMs, 0),
    steps: stepIds
      .map((stepId) => {
        const calls = usage.filter((u) => (u.stepId ?? '(none)') === stepId);
        return {
          stepId,
          calls: calls.length,
          costUsd: calls.reduce((sum, u) => sum + Number(u.estimatedCostUsd), 0),
          latencyMs: calls.reduce((sum, u) => sum + u.latencyMs, 0),
        };
      })
      .filter((step) => step.calls > 0),
  };
}
