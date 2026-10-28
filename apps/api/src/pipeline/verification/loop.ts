import type { ClaimAuditStopReason } from '@evidomo/shared';
import { BudgetExceededError } from '../../usage/budget.ts';

// Loop control of the verification step (docs/architecture.md §5 Verification), independent of
// models and storage: audit the draft; while it has flags and revisions remain, revise it with
// those flags and audit the revision. At most `maxRevisionLoops` revisions; stop early once a
// draft is clean.
//
// Budget and failures: the first audit must complete (without it nothing reaches Gate 2, so a
// budget error or a model failure fails the run as everywhere else). Inside a later loop (the
// revision or its audit), a budget cap or a failure that `failureClass` recognises as the
// model's ends the loop instead: the last fully audited draft and its flags go to Gate 2, and the
// unaudited revision, already in the ledger, is not stored. Retrying the whole step would pay for
// every audit again, and a human reviews the draft at Gate 2 anyway. Anything else (abort,
// configuration, programming errors) still fails the execution.

export interface LoopPass<D, A> {
  readonly draft: D;
  readonly audit: A;
}

export interface LoopResult<D, A> {
  /** The initial draft's pass, then one per completed revision. */
  readonly passes: readonly LoopPass<D, A>[];
  readonly stopReason: ClaimAuditStopReason;
  /** The failure class that ended the loop (`revision_failed` only), for the step log. */
  readonly failure?: string;
}

export async function runRevisionLoop<D, A extends { readonly flags: readonly unknown[] }>(params: {
  readonly initial: D;
  readonly maxRevisionLoops: number;
  readonly audit: (draft: D, revision: number) => Promise<A>;
  /** Writes revision `revision` of `draft` from its audit's flags. */
  readonly revise: (draft: D, audit: A, revision: number) => Promise<D>;
  /**
   * The operator-safe class of a failure the loop may absorb, or `undefined` to rethrow it.
   * Without it, only a budget cap ends a loop early.
   */
  readonly failureClass?: (error: unknown) => string | undefined;
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
      const failure = params.failureClass?.(error);
      if (failure !== undefined) return { passes, stopReason: 'revision_failed', failure };
      throw error;
    }
  }
}
