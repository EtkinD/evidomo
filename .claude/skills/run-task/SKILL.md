---
name: run-task
description: Orchestrator loop for one task from docs/tasks.md — pick it, delegate it to the owning agent, verify, commit, and report. Use when the user asks to work on a task ID or "the next task".
argument-hint: '[task-id, e.g. P1-02; empty = next unblocked task]'
---

# Run a task

Target: `$ARGUMENTS` (if empty, pick the next unchecked task whose dependencies are all checked, following roadmap order).

## 1. Select and check

- Read the task in `docs/tasks.md` and confirm all **Depends on** tasks are checked.
- Check `docs/roadmap.md`. If today is past a checkpoint whose condition is unmet, tell the user which cut level applies before starting.
- Find the owner in the **Owners** table of `docs/tasks.md`. Small, contained work may be done directly; anything substantial goes to the owner.

## 2. Delegate

Brief the owning agent with a self-contained prompt:

- the task ID and its **Done when**,
- the doc sections that matter,
- the exact files and areas involved, if known,
- explicit authorizations, if any (live Meta API calls with a dollar budget, a new dependency the user already approved).

Independent tasks owned by different agents may run in parallel.

## 3. Review the result

- Read the agent's report and the actual diff (`git status`, `git diff`). Do not trust the summary alone.
- Re-run verification yourself: the relevant test project, then `npm run lint`, `npm run typecheck`, `npm test`. Add `npm run test:e2e` if UI flows changed.
- If dependencies changed, run `npm run audit:deps`.
- Check each **Done when** criterion against evidence. If something is unmet, send the agent back with specific feedback.
- If the agent requested a dependency, follow the `add-dependency` skill and ask the user before installing.

## 4. Commit

- One logical change per Conventional Commit, without attribution trailers.
- Check the task's box in `docs/tasks.md` in the same commit.
- Commit doc updates the agent made together with the work they describe. Commit `CLAUDE.md` changes separately.

## 5. Report and close

- Tell the user what was done and how it was verified, and list open risks.
- Ask before pushing.
- If the task completes a roadmap phase, propose `npm version minor` (see `CLAUDE.md` → Git) and ask before pushing the tag.
