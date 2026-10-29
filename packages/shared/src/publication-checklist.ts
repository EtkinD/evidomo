import { z } from 'zod';
import { claimAuditVariantSchema } from './claim-audit.ts';
import {
  phrasingCategorySchema,
  type PhrasingCategory,
  type PublicationChecklistItem,
} from './definitions.ts';

// The publication checklist (docs/architecture.md §5, "Publication checklist (P3-07)"): the
// market profile's `publication_checklist` evaluated against the pack as Gate 2 left it. Shared
// because the export (P3-09) renders it in the HTML pack and the portal-fields JSON, and the web
// app shows it. Details name keys, counts, and IDs only, never fact values or copy text, so the
// result has no personal-data scope of its own.

/**
 * Bumped when a rule's meaning changes, so a stored result says which semantics produced it.
 * v1: `fact_present` = a verified, non-photo fact on the profile measure; `staged_images_labeled`
 * = every approved staged image records the visible disclosure; `no_flagged_phrasing` = every
 * remaining flag of the category was decided at Gate 2, and approving one as written counts only
 * outside `NON_OVERRIDABLE_PHRASING_CATEGORIES`.
 */
export const PUBLICATION_CHECKLIST_RULES_VERSION = 1;

/**
 * Categories whose flag an operator cannot approve as written: `accept` at Gate 2 still records
 * the decision, but the checklist item fails. Exclusionary listing copy carries legal
 * (equal-treatment) risk, so a single click must not make the pack look ready to publish.
 */
export const NON_OVERRIDABLE_PHRASING_CATEGORIES = [
  'exclusionary',
] as const satisfies readonly PhrasingCategory[];

export function isOverridablePhrasingCategory(category: PhrasingCategory): boolean {
  return !NON_OVERRIDABLE_PHRASING_CATEGORIES.some((c) => c === category);
}

/**
 * - `pass`: the item holds for the pack.
 * - `fail`: it does not, or it cannot be shown to hold (fail-closed).
 * - `not_applicable`: nothing in the pack is subject to it (no approved staged images).
 */
export const CHECKLIST_ITEM_STATUSES = ['pass', 'fail', 'not_applicable'] as const;
export const checklistItemStatusSchema = z.enum(CHECKLIST_ITEM_STATUSES);
export type ChecklistItemStatus = z.infer<typeof checklistItemStatusSchema>;

/** Every rule kind of the market profile schema; the evaluator implements each. */
export const PUBLICATION_CHECKLIST_RULES = [
  'fact_present',
  'staged_images_labeled',
  'no_flagged_phrasing',
] as const satisfies readonly PublicationChecklistItem['rule'][];
export type PublicationChecklistRule = (typeof PUBLICATION_CHECKLIST_RULES)[number];

const count = z.int().nonnegative();
const ids = z.array(z.uuid());

const itemCommon = {
  /** The profile item's `id`. */
  id: z.string().min(1).max(64),
  /** The profile item's `label`, shown as the checklist line. */
  label: z.string().min(1).max(200),
  status: checklistItemStatusSchema,
  /** One English sentence for the operator: why the item has this status. */
  detail: z.string().min(1).max(500),
};

const itemResultUnionSchema = z.discriminatedUnion('rule', [
  z.strictObject({
    ...itemCommon,
    rule: z.literal('fact_present'),
    /** The market fact key. */
    fact: z.string().min(1).max(64),
    /** The verified facts on the profile measure that carry the value (fact sheet links). */
    factIds: ids,
    /** Copy variants that cite one of those facts after Gate 2 (informational). */
    citedIn: z.array(claimAuditVariantSchema),
  }),
  z.strictObject({
    ...itemCommon,
    rule: z.literal('staged_images_labeled'),
    /** The approved `staged_image` artifacts the pack shows. */
    stagedArtifactIds: ids,
    /** Those whose record lacks the visible "Virtually staged" disclosure. */
    unlabeledArtifactIds: ids,
  }),
  z.strictObject({
    ...itemCommon,
    rule: z.literal('no_flagged_phrasing'),
    category: phrasingCategorySchema,
    /** The claim audit's rubric covered the category (else the item fails: nobody checked). */
    audited: z.boolean(),
    /** Claims with a remaining flag of the category and no Gate 2 decision. */
    unresolvedClaimIds: ids,
    /**
     * Flagged claims the operator approved as written (an override, shown in the pack). In a
     * non-overridable category any entry fails the item.
     */
    acceptedClaimIds: ids,
    /** Flagged claims the operator rewrote at Gate 2 (not re-audited). */
    editedClaimIds: ids,
    /** Flagged claims the operator removed from the copy. */
    removedClaimIds: ids,
  }),
]);

export const publicationChecklistItemResultSchema = itemResultUnionSchema.superRefine(
  (item, ctx) => {
    const allowed = allowedStatuses(item);
    if (!allowed.includes(item.status)) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `This evidence allows status ${allowed.map((s) => `"${s}"`).join(' or ')}`,
      });
    }
  },
);
export type PublicationChecklistItemResult = z.infer<typeof publicationChecklistItemResultSchema>;

/** The statuses an item's evidence allows, so a stored result cannot contradict itself. */
function allowedStatuses(
  item: z.infer<typeof itemResultUnionSchema>,
): readonly ChecklistItemStatus[] {
  switch (item.rule) {
    case 'fact_present':
      // A fact alone does not decide: several different verified values fail too.
      return item.factIds.length === 0 ? ['fail'] : ['pass', 'fail'];
    case 'staged_images_labeled':
      if (item.stagedArtifactIds.length === 0) return ['not_applicable'];
      return item.unlabeledArtifactIds.length > 0 ? ['fail'] : ['pass'];
    case 'no_flagged_phrasing':
      return !item.audited ||
        item.unresolvedClaimIds.length > 0 ||
        (item.acceptedClaimIds.length > 0 && !isOverridablePhrasingCategory(item.category))
        ? ['fail']
        : ['pass'];
    default: {
      const unreachable: never = item;
      throw new Error(`Unhandled checklist rule: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The checklist as evaluated for one run. A failing item does not block export: the pack shows
 * every item, and `readyToPublish` is false while any item fails.
 */
export const publicationChecklistResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    rulesVersion: z.int().positive(),
    market: z.strictObject({ id: z.string().min(1), version: z.int().positive() }),
    /** In the profile's order. */
    items: z.array(publicationChecklistItemResultSchema),
    summary: z.strictObject({
      /** True exactly when no item fails (`not_applicable` does not count against it). */
      readyToPublish: z.boolean(),
      counts: z.strictObject({ items: count, pass: count, fail: count, notApplicable: count }),
    }),
  })
  .superRefine((result, ctx) => {
    const seen = new Set<string>();
    result.items.forEach((item, i) => {
      if (seen.has(item.id)) {
        ctx.addIssue({ code: 'custom', path: ['items', i, 'id'], message: 'Duplicate item ID' });
      }
      seen.add(item.id);
    });
    const { counts } = result.summary;
    const of = (status: ChecklistItemStatus) =>
      result.items.filter((item) => item.status === status).length;
    if (
      counts.items !== result.items.length ||
      counts.pass !== of('pass') ||
      counts.fail !== of('fail') ||
      counts.notApplicable !== of('not_applicable')
    ) {
      ctx.addIssue({ code: 'custom', path: ['summary', 'counts'], message: 'Counts must match' });
    }
    if (result.summary.readyToPublish !== (counts.fail === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['summary', 'readyToPublish'],
        message: 'readyToPublish is true exactly when no item fails',
      });
    }
  });
export type PublicationChecklistResult = z.infer<typeof publicationChecklistResultSchema>;
