import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError } from '../../usage/budget.ts';
import { runRevisionLoop } from './loop.ts';

// Loop control without models: drafts are revision numbers, audits carry a scripted flag count.

interface Audit {
  readonly flags: readonly string[];
}

function script(flagCounts: readonly number[]) {
  const audit = vi.fn((draft: number) =>
    Promise.resolve<Audit>({ flags: Array.from({ length: flagCounts[draft] ?? 0 }, () => 'flag') }),
  );
  const revise = vi.fn((_draft: number, _audit: Audit, revision: number) =>
    Promise.resolve(revision),
  );
  return { audit, revise };
}

describe('revision loop', () => {
  it('stops after one audit when the first draft is clean', async () => {
    const { audit, revise } = script([0]);
    const result = await runRevisionLoop({ initial: 0, maxRevisionLoops: 2, audit, revise });
    expect(result.stopReason).toBe('clean');
    expect(result.passes.map((p) => p.draft)).toEqual([0]);
    expect(revise).not.toHaveBeenCalled();
  });

  it('revises with the flagged audit and stops early once a revision is clean', async () => {
    const { audit, revise } = script([2, 0]);
    const result = await runRevisionLoop({ initial: 0, maxRevisionLoops: 2, audit, revise });
    expect(result.stopReason).toBe('clean');
    expect(result.passes.map((p) => [p.draft, p.audit.flags.length])).toEqual([
      [0, 2],
      [1, 0],
    ]);
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledWith(0, { flags: ['flag', 'flag'] }, 1);
  });

  it('makes at most max_revision_loops revisions and then hands the flags on', async () => {
    const { audit, revise } = script([3, 2, 1, 1]);
    const result = await runRevisionLoop({ initial: 0, maxRevisionLoops: 2, audit, revise });
    expect(result.stopReason).toBe('loop_limit');
    expect(result.passes.map((p) => p.draft)).toEqual([0, 1, 2]);
    expect(audit).toHaveBeenCalledTimes(3);
    expect(revise).toHaveBeenCalledTimes(2);
  });

  it('audits once and revises nothing with max_revision_loops 0', async () => {
    const { audit, revise } = script([1]);
    const result = await runRevisionLoop({ initial: 0, maxRevisionLoops: 0, audit, revise });
    expect(result).toMatchObject({ stopReason: 'loop_limit', passes: [{ draft: 0 }] });
    expect(revise).not.toHaveBeenCalled();
  });

  it('ends at the last audited draft when a budget cap is reached in a revision loop', async () => {
    const budget = new BudgetExceededError('run', '1.00', '1.00000000');
    const { audit } = script([1, 1]);
    const failingRevise = vi.fn(() => Promise.reject(budget));
    await expect(
      runRevisionLoop({ initial: 0, maxRevisionLoops: 2, audit, revise: failingRevise }),
    ).resolves.toMatchObject({ stopReason: 'budget', passes: [{ draft: 0 }] });

    // The cap reached in the revision's audit: the unaudited revision is not a pass.
    const auditTwice = vi.fn((draft: number) =>
      draft === 0 ? Promise.resolve<Audit>({ flags: ['flag'] }) : Promise.reject(budget),
    );
    const result = await runRevisionLoop({
      initial: 0,
      maxRevisionLoops: 2,
      audit: auditTwice,
      revise: (_draft: number, _audit: Audit, revision: number) => Promise.resolve(revision),
    });
    expect(result).toMatchObject({ stopReason: 'budget', passes: [{ draft: 0 }] });
  });

  it('fails when the first audit cannot be paid for, and on any other error', async () => {
    const budget = new BudgetExceededError('daily', '5.00', '5.00000000');
    await expect(
      runRevisionLoop({
        initial: 0,
        maxRevisionLoops: 2,
        audit: () => Promise.reject(budget),
        revise: () => Promise.resolve(1),
      }),
    ).rejects.toBe(budget);
    const failure = new Error('model failure');
    await expect(
      runRevisionLoop({
        initial: 0,
        maxRevisionLoops: 2,
        audit: () => Promise.resolve<Audit>({ flags: ['flag'] }),
        revise: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
  });
});
