# Evidomo — project instructions

## Context

- Product, architecture, roadmap, and tasks live in `docs/`. Work task by task from `docs/tasks.md`; respect the checkpoints and cut order in `docs/roadmap.md`.
- Check a task's box only when its "Done when" is demonstrably true. When a decision or interface changes, update `docs/architecture.md` (or `docs/model-notes.md` for model findings) in the same piece of work.
- This is a public hackathon repository: everything must be new work. Never commit secrets, `.env` files, personal data (including in fixtures), or third-party content (stock photos included, even when licensed).
- Raw property samples live outside the repository in `../samples/`. Never commit them or anything derived from them (cassettes, masks, exports).

## Orchestration

- The main session is the orchestrator: it plans, delegates, verifies, and commits. It implements only small, contained changes itself (docs, config tweaks, one-file fixes).
- Implementation goes to the owning agent from the **Owners** table in `docs/tasks.md`: `frontend-developer`, `backend-developer`, `ai-pipeline-engineer`, `devops-engineer`. `/run-task <ID>` runs the full loop: delegate → review the diff → verify → commit.
- Independent tasks with different owners may run in parallel. Agents never commit, push, tick tasks, or add dependencies.
- Substantial work runs in a worktree under `.claude/worktrees/`. The orchestrator merges it with the procedure in `run-task`.
- `code-reviewer` (large diffs) and `media-inspector` (images, rendered packs) are read-only helpers that keep the orchestrator's context small.

## Claude Code configuration

- Keep this file short. File-specific conventions go in path-scoped `.claude/rules/`, repeatable procedures in `.claude/skills/`, roles in `.claude/agents/`, and anything that must always happen in hooks or permission rules in `.claude/settings.json`.
- Add or change these only when it measurably helps — a repeated mistake, a repeated procedure, an invariant worth enforcing — and remove what goes stale. The orchestrator's periodic improvement review and lessons log live in the gitignored `CLAUDE.local.md`.

## Commands

| Command                                                        | Purpose                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| `npm run lint` / `npm run format:check`                        | ESLint (type-aware for TS) / Prettier                        |
| `npm run typecheck`                                            | Root configs + every workspace (TypeScript pinned to `~6.0`) |
| `npx vitest run --project <shared\|api\|api-integration\|web>` | One test project — run the narrowest one first               |
| `npm test` / `npm run test:e2e`                                | All Vitest projects (integration needs Docker) / Playwright  |
| `npm run audit:deps`                                           | `npm audit` (moderate and above fail) + registry signatures  |
| `npm run build`                                                | Web production build                                         |
| `npm run db:up` / `db:migrate` / `db:generate`                 | Local PostgreSQL and Drizzle migrations                      |
| `npm run dev:api` / `dev:worker` / `dev:web`                   | Local dev processes (read `.env` at the repo root)           |

## Security

- Target: zero known vulnerabilities. `npm run audit:deps` must pass. A hook audits after every npm install, update, or uninstall Claude runs, and CI audits every push and runs daily.
- Fix advisories by upgrading or adding an `overrides` entry, then verify that the affected tool still works. Never run `npm audit fix --force`.
- npm blocks install scripts by default and none are currently required. Approve one only when a package does not work without it.
- New dependencies follow the `add-dependency` skill and need the user's approval.

## Git

- Commit directly to `main`; keep CI green. Conventional Commits, one logical change per commit, no attribution trailers.
- **Versioning with `npm version`:**
  - Completing a roadmap phase → `npm version minor` (Phase 0 → `0.1.0`, Phase 1 → `0.2.0`, …).
  - Fixes after a phase release → `npm version patch`.
  - `major` is reserved for the first production release.
  - Use npm's default commit message and tag (`vX.Y.Z`); `preversion` runs lint, typecheck, tests, and the audit first.
- Never push commits or tags without explicit approval in the current conversation.
