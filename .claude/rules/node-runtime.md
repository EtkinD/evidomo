---
paths:
  - 'apps/api/**/*.ts'
  - 'packages/shared/**/*.ts'
  - '.claude/hooks/**/*.ts'
---

# Node runtime code (api, worker, shared)

These files run on Node's native TypeScript type stripping. There is no build step and no transpiler.

- Use erasable syntax only: no `enum`, no parameter properties, no namespaces with runtime code, no decorators. Use `as const` objects or string unions instead of enums.
- Relative imports carry the `.ts` extension (`./db/client.ts`). Workspace packages are imported by name (`@evidomo/shared`). tsconfig `paths` aliases are not supported.
- Type-only imports use `import type` (enforced by `verbatimModuleSyntax` and ESLint).
- Validate boundary data (env, HTTP input, JSON from the DB or models) with zod before use.
- Log with the injected pino logger, not `console`. Never log secrets, tokens, or personal data.
- Handle errors explicitly. A caught error is either handled, rethrown with context, or logged together with a deliberate fallback.
