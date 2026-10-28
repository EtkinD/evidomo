---
paths:
  - 'apps/api/src/meta/**'
  - 'apps/api/src/pipeline/**'
  - 'definitions/**'
  - 'fixtures/**'
---

# Meta Model API and pipeline

- Use Standard mode only. Model IDs ending in `-contributor` are forbidden for this product.
- All model access goes through the `meta` module. The Vercel AI SDK is the primary client; the `openai` package covers its gaps. SDK retry settings are the only retry layer.
- Model, reasoning effort, and fallback model come from the service definition, never from hardcoded values in a step.
- Every call records usage and estimated cost in the usage ledger, and per-run and daily budget caps apply.
- Tests and CI use recorded fixtures (MSW). Live calls spend real, limited credit and happen only when explicitly authorized.
- Fixtures and eval data contain no personal data (faces, plates, addresses, names).
- Provenance is enforced in code: generated claims must cite known fact IDs, and numbers must match the cited facts exactly.
