---
name: task-protocol
description: Working protocol for a subagent implementing one task from docs/tasks.md — preparation, boundaries, verification, and the report format the orchestrator expects.
user-invocable: false
---

# Task protocol (delegated implementation)

You implement one task handed to you by the orchestrator (the main session). You do not see the conversation with the user — the brief and the repository are your only context.

## Before writing code

1. Read the task in `docs/tasks.md`: its **Done when** is your acceptance contract. Confirm every task in **Depends on** is checked; if one is not, stop and report.
2. Read the relevant sections of `docs/architecture.md` and `docs/product.md` named in the brief.
3. Inspect the existing code you will touch and follow its patterns.
4. Check library APIs from primary sources, not memory: installed type definitions in `node_modules`, Next.js bundled docs (`node_modules/next/dist/docs/02-pages/`), and official docs. Several dependencies are newer than typical training data (Next 16, AI SDK 7, Vitest 5, MSW 3, pg-boss 12, Zod 4, ESLint 10, TypeScript 6).

## Boundaries — never do these

- Commit, push, tag, or run `npm version` (the orchestrator commits after review).
- Check task boxes in `docs/tasks.md`.
- Add, upgrade, or remove a dependency. Evaluate it with the `add-dependency` skill and put the request in your report instead.
- Make live Meta Model API calls or spend credits, unless the brief explicitly authorizes them with a budget.
- Run anything against a remote server, DNS, or production.
- Read, print, or edit `.env` files.
- Weaken tests, lint rules, or compiler strictness to get green checks.
- Use `git stash` in any form: the stash stack is shared by every worktree and session, so a pop can take someone else's work. Ask the orchestrator if you need to set work aside.
- Reformat or rewrite content outside your change. Edit files in place, and never round-trip a JSON or YAML file through a serializer, which re-escapes characters and reorders keys.
- Copy raw property samples (`../samples/`), or anything derived from them (cassettes, exports, masks), into the repository.

If the task cannot be finished within these limits, stop and report what blocks it.

## Worktree and live sessions

- When the brief gives you a worktree, work and run every command there. Leave all changes uncommitted: the orchestrator commits, rebases, and merges.
- Live Meta API calls follow the brief's budget and stop line exactly. After each live session, report the actual new spend. In record mode the usage ledger also meters responses replayed from the cassette, so its total over-counts.
- Re-recorded fixtures replace stale ones. Delete `.files/` blobs nothing references any more.

## Verify before reporting

Run the narrowest relevant checks first, then the broader ones:

1. The affected test project, e.g. `npx vitest run --project api`.
2. `npm run typecheck` and `npm run lint`.
3. `npm run test:e2e` when a user flow changed.

Do not claim something works unless a command proved it.

## Report format

Write the report in Turkish prose, and keep technical terms, identifiers, paths, and commands in English.

- **Summary:** what was built, in 2–4 sentences.
- **Files changed:** paths, with one line each on why.
- **Done when:** each criterion, marked met / not met, with the evidence.
- **Verification:** the commands you ran and their results.
- **Decisions and deviations:** anything that differs from the docs, and which docs you updated.
- **Dependency requests:** package, purpose, and the `add-dependency` evaluation (if any).
- **Risks and follow-ups.**
