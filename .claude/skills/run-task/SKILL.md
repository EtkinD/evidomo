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

The agent's preloaded `task-protocol` already carries the standing boundaries: no commits, no stash, no `.env`, no raw samples, a Turkish report. Do not repeat them; state only what is specific to this task.

**Worktree.** Substantial work runs in its own worktree, created before the agent starts. Name the path in the brief.

```sh
git worktree add -q .claude/worktrees/<id> -b wip/<id> main
cd .claude/worktrees/<id> && npm ci --ignore-scripts
```

**Live budget.** When live calls are authorized, the brief states three things:

- the task budget, taken from the phase budget recorded in auto memory;
- a stop line at 80% of that budget, where the agent asks before continuing;
- the record command (`RECORD=1 node --env-file=<repo>/.env …`, or the CLI's `--mode record`).

Raise a task budget yourself only within the user's phase authorization, and say so in the report. Content-dependent pipeline changes include one live check on the real sample set (`../samples/example-house-1`, outputs kept outside the repo).

**Rate limits.** If an agent stops on a usage limit, its worktree persists. Resume the agent with `SendMessage`; never start a duplicate.

Independent tasks owned by different agents may run in parallel.

Each agent's frontmatter sets its default model and effort: `ai-pipeline-engineer` runs on opus/high, and the others on sonnet (backend high; frontend and devops medium). For a task where a subtle mistake is costly, pass `model: opus` when spawning a sonnet agent:

- auth, sessions, or access control;
- a migration or data deletion;
- run-engine concurrency or idempotency;
- a security fix.

Do not raise the default for routine work.

## 3. Review the result

- Read the agent's report and the actual diff (`git status`, `git diff`). Do not trust the summary alone.
- For a large diff (roughly 1,000 changed lines or more, or several areas), first have the `code-reviewer` agent review it, then check its findings yourself. Look at sample outputs (HTML, images) through the `media-inspector` agent or downscaled copies, never full-resolution files. Ask implementing agents for at most 4 screenshots (changed screens, mobile, light and dark) unless more are needed, and send them to `media-inspector` in one batch.
- Check that nothing from the raw samples, no secret, and no incidental reformatting entered the diff.
- Re-run verification yourself: the relevant test project, then `npm run lint`, `npm run typecheck`, `npm test`. Add `npm run test:e2e` if UI flows changed.
- If dependencies changed, run `npm run audit:deps`.
- Check each **Done when** criterion against evidence. If something is unmet, send the agent back with specific feedback.
- If the agent requested a dependency, follow the `add-dependency` skill and ask the user before installing.

## 4. Commit

- One logical change per Conventional Commit, without attribution trailers.
- Check the task's box in `docs/tasks.md` in the same commit.
- Commit doc updates the agent made together with the work they describe. Commit `CLAUDE.md` changes separately.
- **New migration:** show the user the SQL and wait for an explicit approval before committing or merging it. Never apply it to a database first. The `migration-approval` hook enforces this: in modes that do not ask, prefix the approved command with `EVIDOMO_MIGRATION_APPROVED=1`.
- **Merge procedure for a worktree:**

  ```sh
  git -C .claude/worktrees/<id> add -A
  git -C .claude/worktrees/<id> commit -m "wip: <id>"
  git -C .claude/worktrees/<id> rebase main
  # resolve conflicts, verify, tick the box
  git -C .claude/worktrees/<id> commit --amend -m "<final message>"
  git merge --ff-only wip/<id>
  git worktree remove .claude/worktrees/<id> && git branch -d wip/<id>
  ```

  Run these steps so that a failure stops the sequence: `set -e`, or check each exit code. Never pipe `git rebase` or `git merge` into `tail` or `grep` inside an `&&` chain: the pipe returns the filter's exit code, so a failed rebase lets the chain go on to `git worktree remove --force`.

  Never squash with `git reset --soft main`. A worktree based on an older commit would revert everything main gained since.

## 5. Report and close

- Tell the user what was done and how it was verified, and list open risks.
- Ask before pushing.
- If the task completes a roadmap phase, run the Claude Code improvement review in `CLAUDE.local.md` first. Then propose `npm version minor` (see `CLAUDE.md` → Git) and ask before pushing the tag.
- Report live spend against the phase budget, and update the budget entry in auto memory.
