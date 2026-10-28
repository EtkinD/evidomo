---
name: add-dependency
description: Evaluate, approve, install, and security-check a new npm dependency. Use before adding, upgrading, or replacing any runtime or dev dependency.
---

# Adding a dependency

The user approves every new dependency. This procedure produces the evidence for that decision and keeps the tree free of known vulnerabilities.

## 1. Justify the need

- Can an existing dependency or a Node/browser built-in do the job?
- Policy (`docs/architecture.md` §1): prefer an established, well-maintained library over hand-rolled code, unless the library is disproportionately heavy for the job — then native code wins.

## 2. Evaluate the candidate

```sh
npm view <pkg> version license engines repository.url time.modified dist.unpackedSize dependencies
curl -s https://api.npmjs.org/downloads/point/last-week/<pkg>
```

Check:

- maintenance (recent releases, open security issues),
- license compatibility with Apache-2.0,
- bundled TypeScript types,
- ESM support,
- number of transitive dependencies,
- install scripts.

For web dependencies, also consider bundle size.

## 3. Request approval

Present one line per package: `<pkg>@<version>` — purpose, alternatives considered, size and transitive deps, license, maintenance signal.

- A subagent puts this in its report and stops.
- The orchestrator asks the user and waits for approval.

## 4. Install into the right workspace

```sh
npm install <pkg> -w @evidomo/<api|web|shared>              # runtime
npm install --save-dev <pkg> -w @evidomo/<api|web|shared>   # dev only
npm install --save-dev <pkg>                                 # root tooling
```

## 5. Security gate

- `npm run audit:deps` must pass. The target is 0 known vulnerabilities.
- To fix an advisory, upgrade the package, or add an `overrides` entry and then verify that the affected tool still works. Never run `npm audit fix --force`.
- `npm install-scripts ls` lists install scripts that npm blocked. Approve one (`npm install-scripts approve <pkg>`) only if the package does not work without it, and state why.

## 6. Record it

Add notable dependencies to the stack table in `docs/architecture.md`, with their single purpose.
