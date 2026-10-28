import type { ClaimAuditStopReason } from '@evidomo/shared';
import { BudgetExceededError } from '../../usage/budget.ts';

// Loop control of the verification step (docs/architecture.md §5 Verification), independent of
// models and storage: audit the draft; while it has flags and revisions remain, revise it with
// those flags and audit the revision. At most `maxRevisionLoops` revisions; stop early once a
// draft is clean.
//
// Budget: the first audit must complete (without it nothing reaches Gate 2, so a budget error
// fails the run as everywhere else). A cap reached inside a later loop (the revision or its
// audit) ends the loop instead: the last fully audited draft and its flags go to Gate 2, and the
// unaudited revision, already in the ledger, is not stored.

export interface LoopPass<D, A> {
  readonly draft: D;
  readonly audit: A;
}

export interface LoopResult<D, A> {
  /** The initial draft's pass, then one per completed revision. */
  readonly passes: readonly LoopPass<D, A>[];
  readonly stopReason: ClaimAuditStopReason;
}

export async function runRevisionLoop<D, A extends { readonly flags: readonly unknown[] }>(params: {
  readonly initial: D;
  readonly maxRevisionLoops: number;
  readonly audit: (draft: D, revision: number) => Promise<A>;
  /** Writes revision `revision` of `draft` from its audit's flags. */
  readonly revise: (draft: D, audit: A, revision: number) => Promise<D>;
}): Promise<LoopResult<D, A>> {
  const passes: LoopPass<D, A>[] = [
    { draft: params.initial, audit: await params.audit(params.initial, 0) },
  ];
  for (;;) {
    const last = passes[passes.length - 1];
    // `passes` starts with one entry and only grows.
    if (last === undefined) throw new Error('unreachable: no audit pass');
    if (last.audit.flags.length === 0) return { passes, stopReason: 'clean' };
    const revision = passes.length;
    if (revision > params.maxRevisionLoops) return { passes, stopReason: 'loop_limit' };
    try {
      const draft = await params.revise(last.draft, last.audit, revision);
      passes.push({ draft, audit: await params.audit(draft, revision) });
    } catch (error) {
      if (error instanceof BudgetExceededError) return { passes, stopReason: 'budget' };
      throw error;
    }
  }
}
