import {
  claimAuditVariantSchema,
  claimDecisionRequestSchema,
  factConflictDecisionRequestSchema,
  stagedImageDecisionRequestSchema,
  type ClaimAuditGateResponse,
  type ClaimAuditGateSegment,
  type ClaimAuditVariant,
  type FactConflictsGateResponse,
  type FactSourceKind,
  type GateConflict,
  type ParsedClaimDecisionRequest,
  type ParsedFactConflictDecisionRequest,
  type StagedImageDecisionRequest,
} from '@evidomo/shared';
import { z } from 'zod';

// The scripted decisions file of a pipeline project directory (docs/architecture.md §5,
// "Headless pipeline CLI"). Run IDs, fact IDs, and claim IDs are created per run, so decisions
// address what is stable in a project: a conflict by its fact key, a claim by its variant and
// position, a staged image by the photo file it was made from. Everything a file does not list
// is decided by its section's default policy.

export const DECISIONS_FORMAT_VERSION = 1;

const scalar = z.union([z.number(), z.string().trim().min(1).max(300), z.boolean()]);
const factKey = z.string().min(1).max(80);

/**
 * Which side of a conflict to accept: the one holding a fact from this source, the one with this
 * value, or the side at this 1-based position as Gate 1 lists them (the order is stable for a
 * replayed run; recorded Gate 1 paths use it, `recorded-paths.ts`).
 */
const sideSelectorSchema = z.union([
  z.strictObject({ source: z.enum(['form', 'transcript', 'photo']) }),
  z.strictObject({ value: scalar }),
  z.strictObject({ position: z.int().min(1).max(20) }),
]);
export type SideSelector = z.infer<typeof sideSelectorSchema>;

const factConflictEntrySchema = z.discriminatedUnion('choice', [
  z.strictObject({ key: factKey, choice: z.literal('accept'), side: sideSelectorSchema }),
  z.strictObject({
    key: factKey,
    choice: z.literal('edit'),
    value: scalar,
    unit: z.string().trim().min(1).max(40).nullable().optional(),
    basis: z.string().trim().min(1).max(40).nullable().optional(),
  }),
  z.strictObject({ key: factKey, choice: z.literal('reject') }),
]);
export type FactConflictEntry = z.infer<typeof factConflictEntrySchema>;

// `qa` addresses a buyer Q&A answer segment by its position across all cards (Gate 2's
// `position`, the audit's `Q01` = 0).
const claimEntrySchema = z.discriminatedUnion('choice', [
  z.strictObject({
    variant: claimAuditVariantSchema,
    position: z.int().nonnegative(),
    choice: z.enum(['accept', 'remove']),
  }),
  z.strictObject({
    variant: claimAuditVariantSchema,
    position: z.int().nonnegative(),
    choice: z.literal('edit'),
    text: z.string().min(1).max(8000),
  }),
]);
export type ClaimEntry = z.infer<typeof claimEntrySchema>;

const imageEntrySchema = z.strictObject({
  /** File name (basename) of the project photo the staged image was made from. */
  photo: z.string().min(1).max(255),
  choice: z.enum(['accept', 'reject']),
});
export type ImageEntry = z.infer<typeof imageEntrySchema>;

/**
 * Gate 1 defaults:
 * - `accept_form_else_reject` keeps the side holding the fact form's value (the service's source
 *   of truth); a conflict no form value takes part in (e.g. the walkthrough against a photo on an
 *   `other:` key) has no authoritative side, so every side is rejected and nothing is published;
 * - `accept_first` keeps the first side as reconciliation listed it;
 * - `reject` keeps no value;
 * - `fail` stops the CLI, so an unlisted conflict is never decided silently.
 */
export const FACT_CONFLICT_POLICIES = [
  'accept_form_else_reject',
  'accept_first',
  'reject',
  'fail',
] as const;
export const CLAIM_POLICIES = ['remove', 'accept', 'fail'] as const;
export const IMAGE_POLICIES = ['accept', 'reject', 'fail'] as const;

function unique<T>(items: readonly T[], keyOf: (item: T) => string): boolean {
  return new Set(items.map(keyOf)).size === items.length;
}

export const decisionsFileSchema = z.strictObject({
  formatVersion: z.literal(DECISIONS_FORMAT_VERSION),
  factConflicts: z.strictObject({
    default: z.enum(FACT_CONFLICT_POLICIES),
    decisions: z
      .array(factConflictEntrySchema)
      .default([])
      .refine((entries) => unique(entries, (e) => e.key), 'One decision per fact key'),
  }),
  claimAudit: z.strictObject({
    claims: z.strictObject({
      /** `remove` drops a flagged segment, `accept` publishes it as written. */
      default: z.enum(CLAIM_POLICIES),
      decisions: z
        .array(claimEntrySchema)
        .default([])
        .refine(
          (entries) => unique(entries, (e) => `${e.variant}:${e.position}`),
          'One decision per variant and position',
        ),
    }),
    images: z.strictObject({
      /** `accept` publishes every staged image the integrity check offers. */
      default: z.enum(IMAGE_POLICIES),
      decisions: z
        .array(imageEntrySchema)
        .default([])
        .refine((entries) => unique(entries, (e) => e.photo), 'One decision per photo'),
    }),
  }),
});
export type DecisionsFile = z.infer<typeof decisionsFileSchema>;

/** A scripted decision cannot be applied to what the run produced. */
export class ScriptedDecisionError extends Error {
  override name = 'ScriptedDecisionError';
}

export type DecisionOrigin = 'decisions_file' | 'default_policy';

export interface PlannedConflictDecision {
  readonly conflictId: string;
  readonly key: string;
  readonly request: ParsedFactConflictDecisionRequest;
  /** One line for the summary, e.g. `accept transcript side (1987)`. */
  readonly label: string;
  readonly origin: DecisionOrigin;
}

export interface Plan<T> {
  readonly decisions: readonly T[];
  /** Listed decisions that matched nothing in this run (live output varies between runs). */
  readonly unused: readonly string[];
}

const SOURCE_KINDS: Readonly<Record<'form' | 'transcript' | 'photo', FactSourceKind>> = {
  form: 'form',
  transcript: 'transcript_turn',
  photo: 'photo_region',
};

function describeValue(side: GateConflict['sides'][number]): string {
  const unit = side.unit === null ? '' : ` ${side.unit}`;
  const basis = side.basis === null ? '' : ` ${side.basis}`;
  return `${JSON.stringify(side.value)}${unit}${basis}`;
}

function acceptSide(
  conflict: GateConflict,
  side: GateConflict['sides'][number] | undefined,
  label: string,
  origin: DecisionOrigin,
): PlannedConflictDecision {
  const fact = side?.facts[0];
  if (side === undefined || fact === undefined) {
    throw new ScriptedDecisionError(
      `Conflict ${conflict.id} (${conflict.key}) has no side to accept`,
    );
  }
  return {
    conflictId: conflict.id,
    key: conflict.key,
    request: factConflictDecisionRequestSchema.parse({ choice: 'accept', factId: fact.id }),
    label: `accept ${label} (${describeValue(side)})`,
    origin,
  };
}

function selectSide(conflict: GateConflict, selector: SideSelector): GateConflict['sides'][number] {
  if ('position' in selector) {
    const side = conflict.sides[selector.position - 1];
    if (side === undefined) {
      throw new ScriptedDecisionError(
        `Conflict ${conflict.id} (${conflict.key}) has ${conflict.sides.length} sides, not a ` +
          `side ${selector.position}. Sides: ${conflict.sides.map(describeValue).join(' | ')}`,
      );
    }
    return side;
  }
  const matches =
    'source' in selector
      ? conflict.sides.filter((side) => side.sourceKinds.includes(SOURCE_KINDS[selector.source]))
      : conflict.sides.filter((side) => side.value === selector.value);
  const wanted =
    'source' in selector ? `a ${selector.source} fact` : `value ${JSON.stringify(selector.value)}`;
  const [side, ...more] = matches;
  if (side === undefined || more.length > 0) {
    throw new ScriptedDecisionError(
      `Conflict ${conflict.id} (${conflict.key}): ${matches.length} sides hold ${wanted}, ` +
        `expected exactly one. Sides: ${conflict.sides.map(describeValue).join(' | ')}`,
    );
  }
  return side;
}

function scriptedConflictDecision(
  conflict: GateConflict,
  entry: FactConflictEntry,
): PlannedConflictDecision {
  switch (entry.choice) {
    case 'accept': {
      const side = selectSide(conflict, entry.side);
      const label =
        'source' in entry.side
          ? `${entry.side.source} side`
          : 'position' in entry.side
            ? `side ${entry.side.position}`
            : 'side';
      return acceptSide(conflict, side, label, 'decisions_file');
    }
    case 'edit':
      return {
        conflictId: conflict.id,
        key: conflict.key,
        request: factConflictDecisionRequestSchema.parse({
          choice: 'edit',
          value: entry.value,
          ...(entry.unit === undefined ? {} : { unit: entry.unit }),
          ...(entry.basis === undefined ? {} : { basis: entry.basis }),
        }),
        label: `edit to ${JSON.stringify(entry.value)}`,
        origin: 'decisions_file',
      };
    case 'reject':
      return {
        conflictId: conflict.id,
        key: conflict.key,
        request: factConflictDecisionRequestSchema.parse({ choice: 'reject' }),
        label: 'reject every side',
        origin: 'decisions_file',
      };
    default: {
      const unreachable: never = entry;
      throw new Error(`Unhandled decision ${JSON.stringify(unreachable)}`);
    }
  }
}

function defaultConflictDecision(
  conflict: GateConflict,
  policy: DecisionsFile['factConflicts']['default'],
): PlannedConflictDecision {
  switch (policy) {
    case 'accept_form_else_reject': {
      const sides = conflict.sides.filter((side) => side.sourceKinds.includes('form'));
      if (sides.length > 1) {
        // The form holds one value per key; two form sides mean the input is not what we think.
        throw new ScriptedDecisionError(
          `Conflict ${conflict.id} (${conflict.key}) has ${sides.length} sides with a fact form ` +
            'value; list a decision for this key',
        );
      }
      if (sides.length === 1) return acceptSide(conflict, sides[0], 'form side', 'default_policy');
      return {
        conflictId: conflict.id,
        key: conflict.key,
        request: factConflictDecisionRequestSchema.parse({ choice: 'reject' }),
        label: 'reject every side (no fact form value)',
        origin: 'default_policy',
      };
    }
    case 'accept_first':
      return acceptSide(conflict, conflict.sides[0], 'first side', 'default_policy');
    case 'reject':
      return {
        conflictId: conflict.id,
        key: conflict.key,
        request: factConflictDecisionRequestSchema.parse({ choice: 'reject' }),
        label: 'reject every side',
        origin: 'default_policy',
      };
    case 'fail':
      throw new ScriptedDecisionError(
        `Conflict ${conflict.id} (${conflict.key}) is not in the decisions file and the default ` +
          'policy is fail',
      );
    default: {
      const unreachable: never = policy;
      throw new Error(`Unhandled policy ${String(unreachable)}`);
    }
  }
}

/** Gate 1: one decision per open conflict. Throws `ScriptedDecisionError` if one cannot be made. */
export function planFactConflictDecisions(
  gate: FactConflictsGateResponse,
  file: DecisionsFile['factConflicts'],
): Plan<PlannedConflictDecision> {
  const byKey = new Map(file.decisions.map((entry) => [entry.key, entry]));
  const usedKeys = new Set<string>();
  const decisions = gate.conflicts
    .filter((conflict) => conflict.decision === null)
    .map((conflict) => {
      const entry = byKey.get(conflict.key);
      if (entry === undefined) return defaultConflictDecision(conflict, file.default);
      usedKeys.add(entry.key);
      return scriptedConflictDecision(conflict, entry);
    });
  const unused = file.decisions
    .filter((entry) => !usedKeys.has(entry.key))
    .map((entry) => `fact conflict "${entry.key}": no open conflict on this key`);
  return { decisions, unused };
}

export interface PlannedClaimDecision {
  readonly claimId: string;
  readonly variant: ClaimAuditVariant;
  readonly position: number;
  /** Remaining flags as `source/category[/code]`, never their text (it quotes copy). */
  readonly flags: readonly string[];
  readonly request: ParsedClaimDecisionRequest;
  readonly origin: DecisionOrigin;
}

export interface PlannedImageDecision {
  readonly artifactId: string;
  readonly photo: string;
  readonly operationId: string;
  readonly request: StagedImageDecisionRequest;
  readonly origin: DecisionOrigin;
}

export interface ClaimAuditPlan {
  readonly claims: readonly PlannedClaimDecision[];
  readonly images: readonly PlannedImageDecision[];
  readonly unused: readonly string[];
}

/**
 * Gate 2: one decision per flagged claim of the final draft and Q&A cards, and per offered
 * staged image.
 * `photoNames` maps a material ID to its project photo's file name.
 */
export function planClaimAuditDecisions(
  gate: ClaimAuditGateResponse,
  file: DecisionsFile['claimAudit'],
  photoNames: ReadonlyMap<string, string>,
): ClaimAuditPlan {
  const claimEntries = new Map(file.claims.decisions.map((e) => [`${e.variant}:${e.position}`, e]));
  const usedClaims = new Set<string>();
  const claims: PlannedClaimDecision[] = [];
  const groups: { kind: ClaimAuditVariant; segments: readonly ClaimAuditGateSegment[] }[] = [
    ...gate.variants,
    { kind: 'qa', segments: gate.qaCards.flatMap((card) => card.segments) },
  ];
  for (const variant of groups) {
    for (const segment of variant.segments) {
      if (segment.flags.length === 0 || segment.decision !== null) continue;
      const address = `${variant.kind}:${segment.position}`;
      const flags = segment.flags.map((flag) =>
        [flag.source, flag.category, flag.code].filter((part) => part !== null).join('/'),
      );
      const entry = claimEntries.get(address);
      let request: ParsedClaimDecisionRequest;
      let origin: DecisionOrigin;
      if (entry !== undefined) {
        usedClaims.add(address);
        origin = 'decisions_file';
        request = claimDecisionRequestSchema.parse(
          entry.choice === 'edit' ? { choice: 'edit', text: entry.text } : { choice: entry.choice },
        );
      } else if (file.claims.default === 'fail') {
        throw new ScriptedDecisionError(
          `Claim ${address} is flagged (${flags.join(', ')}), is not in the decisions file, and ` +
            'the default policy is fail',
        );
      } else {
        origin = 'default_policy';
        request = claimDecisionRequestSchema.parse({ choice: file.claims.default });
      }
      claims.push({
        claimId: segment.claimId,
        variant: variant.kind,
        position: segment.position,
        flags,
        request,
        origin,
      });
    }
  }

  const imageEntries = new Map(file.images.decisions.map((e) => [e.photo, e]));
  const usedImages = new Set<string>();
  const images: PlannedImageDecision[] = [];
  for (const image of gate.images) {
    if (image.decision !== null) continue;
    const photo = photoNames.get(image.materialId);
    if (photo === undefined) {
      throw new ScriptedDecisionError(
        `Staged image ${image.artifactId} names material ${image.materialId}, which is not a project photo`,
      );
    }
    const entry = imageEntries.get(photo);
    if (entry === undefined && file.images.default === 'fail') {
      throw new ScriptedDecisionError(
        `The staged image of ${photo} (${image.operation.id}) is not in the decisions file and ` +
          'the default policy is fail',
      );
    }
    if (entry !== undefined) usedImages.add(photo);
    const choice = entry?.choice ?? (file.images.default === 'reject' ? 'reject' : 'accept');
    images.push({
      artifactId: image.artifactId,
      photo,
      operationId: image.operation.id,
      request: stagedImageDecisionRequestSchema.parse({ choice }),
      origin: entry === undefined ? 'default_policy' : 'decisions_file',
    });
  }

  const unused = [
    ...file.claims.decisions
      .filter((e) => !usedClaims.has(`${e.variant}:${e.position}`))
      .map(
        (e) =>
          `claim ${e.variant}:${e.position}: not a flagged segment of the final draft or Q&A cards`,
      ),
    ...file.images.decisions
      .filter((e) => !usedImages.has(e.photo))
      .map((e) => `image ${e.photo}: no staged image of this photo was offered`),
  ];
  return { claims, images, unused };
}
