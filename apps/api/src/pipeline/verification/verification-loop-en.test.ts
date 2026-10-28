import { describeRecordedVerification } from './recorded-verification.ts';

// Verification scenario "loop-en" (docs/model-notes.md, P3-06): the recorded P3-01 draft, audited by
// Wonder `low` and revised by Spark `medium` (settings pinned in testing.ts). Record (one Wonder
// call per pass, one Spark call per revision; ~$0.05-0.20):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api verification-loop-en
// Structure, code checks, and the recorded outcome are asserted; wording is the models'.
describeRecordedVerification('loop-en', {
  // Pass 0: "a 6 m² external storage is included" (P3-01's risk phrase; "included" is not a
  // fact); revision 1 rewrote that segment only and its re-audit was clean.
  stopReason: 'clean',
  flagsByPass: [[['verifier', 'claim_support']], []],
  auditedByPass: [17, 1],
});
