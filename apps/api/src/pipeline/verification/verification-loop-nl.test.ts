import { describeRecordedVerification } from './recorded-verification.ts';

// Verification scenario "loop-nl" (docs/model-notes.md, P3-06): the recorded P3-01 draft, audited by
// Wonder `low` and revised by Spark `medium` (settings pinned in testing.ts). Record (one Wonder
// call per pass, one Spark call per revision; ~$0.05-0.20):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api verification-loop-nl
// Structure, code checks, and the recorded outcome are asserted; wording is the models'.
describeRecordedVerification('loop-nl', {
  // Pass 0: "appartement van 92 m²" in the opening and the caption states the area without its
  // basis (woonoppervlakte, NEN 2580); revision 1 rewrote both segments with the basis and their
  // re-audit was clean.
  stopReason: 'clean',
  flagsByPass: [
    [
      ['verifier', 'area_basis'],
      ['verifier', 'area_basis'],
    ],
    [],
  ],
  auditedByPass: [18, 2],
});
