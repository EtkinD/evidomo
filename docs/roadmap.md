# Roadmap

Status: Draft — under founder review
Companions: [product.md](./product.md), [architecture.md](./architecture.md), [tasks.md](./tasks.md)

The plan is organized by phases and tasks, not days: progress speed varies, so day-based estimates would mislead. The submission deadline is fixed, so the plan has **dated checkpoints**. A checkpoint is not an estimate — it is a trigger: if its condition is not met by its date, the cut order in §4 is applied.

## 1. Phases

| Phase                                    | Goal                                                                | Exit criteria                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Foundation**                       | A working monorepo with quality gates, public on GitHub             | Clean clone installs; lint, typecheck, and tests pass locally and in CI; LICENSE present; repo public                                                                     |
| **1 — Model spikes**                     | Remove the biggest technical unknowns before building on them       | Every Meta model called successfully and recorded as fixtures; staging go/no-go decided; per-step model and reasoning-effort choices made from measured cost and latency  |
| **2 — Run engine and intake**            | Runs execute reliably up to Gate 1                                  | A headless run on a real property produces a Verified Fact Sheet and conflict list; a worker restart mid-run does not re-run or re-bill completed steps                   |
| **3 — Generation, verification, export** | A complete pack from the command line                               | A headless run (scripted gate decisions) produces the full pack; every claim passes the code-level validator; the pipeline runs fully from fixtures with zero model calls |
| **4 — Web application**                  | Agents can do the whole flow in the browser, including from a phone | Capture → run → Gate 1 → Gate 2 → export works in the browser; demo replay works without login                                                                            |
| **4b — Product UI and brand**            | The web app looks and reads like a real product                     | A design direction chosen in the dev-only showcase is applied: logo, theme, typography, app shell, landing page, and polished app screens; released together with Phase 4 |
| **5 — Hardening and evaluation**         | Trustworthy on real data, measured                                  | Second property completes on production; eval catch rate reported; deletion, error, and budget paths tested; e2e suite green                                              |
| **6 — Release**                          | Shipped                                                             | README complete; demo recorded and published; project submitted                                                                                                           |

**Parallel tracks**

- **D — Deployment:** can start as soon as Phase 0 is done; must be live by Checkpoint 3. Deploying early surfaces infrastructure problems (DNS propagation, HTTPS, ffmpeg in the image) while there is still time to fix them.
- **M — Sample materials:** real property materials from a partnering Dutch agent, with written consent. Phase 1 spikes can use any photos and audio; Phase 2 needs at least one real property set.

## 2. Checkpoints

Times for checkpoints 4–5 are US Eastern (ET), the hackathon's reference timezone (US daylight saving time ends on Nov 1, so ET = UTC−5 for these).

| #   | Deadline               | Condition                                                                            | If missed                                                                   |
| --- | ---------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| CP1 | Fri Oct 30, end of day | Phases 0–1 done; at least one real property set received                             | Apply cut level 1; use the founder's own materials for pipeline development |
| CP2 | Sun Nov 1, end of day  | Phase 2 done; Phase 3 produces copy + claim audit headlessly                         | Apply cut levels 1–2                                                        |
| CP3 | Mon Nov 2, end of day  | Phase 4 usable end to end; Track D live on HTTPS                                     | Apply cut level 3; replay mode becomes the primary public demo              |
| CP4 | Tue Nov 3, 12:00 ET    | **Feature freeze.** Only fixes, hardening, eval, and demo recording after this point | —                                                                           |
| CP5 | Wed Nov 4, 12:00 ET    | **Code freeze.** Submit by 18:00 ET, three hours before the 21:00 ET deadline        | —                                                                           |

## 3. Non-negotiables

These survive every cut: claim provenance enforced in code, the conflict gate, the claim audit, cost ledger with budget caps, and demo replay mode.

## 4. Cut order

Applied in order, one level at a time:

1. Buyer Q&A cards; Netherlands profile reduced to energy label + living area basis.
2. Virtual staging reduced to decluttering/object removal (or removed if the Phase 1 spike already said so); integrity check kept only if staging remains.
3. In-browser voice recording (file upload only); auth reduced to a single access-code login.
4. Second-property hardening (keep one fully working property).

## 5. Definition of done (every task)

- Typecheck, lint, and relevant tests pass.
- New behavior has tests at the narrowest useful level (unit before integration before e2e).
- No secrets, personal data, or third-party content committed.
- Dependency changes pass `npm run audit:deps` (zero known vulnerabilities).
- Docs updated when a decision or interface changes.
