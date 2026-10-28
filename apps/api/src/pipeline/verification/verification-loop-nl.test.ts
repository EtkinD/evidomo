import { describeRecordedVerification } from './recorded-verification.ts';

// Verification scenario "loop-nl" (docs/model-notes.md, P3-06): the recorded P3-01 draft, audited by
// Wonder `low` and revised by Spark `medium` (settings pinned in testing.ts). Record (one Wonder
// call per pass, one Spark call per revision; ~$0.05-0.20):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api verification-loop-nl
// Structure, code checks, and the recorded outcome are asserted; wording is the models'.
describeRecordedVerification('loop-nl', {
  // Pass 0: "Grond in eigendom" (P3-01's risk phrase: ownership inferred from
  // `ground_lease: false`) and "Open hoekkeuken" in the caption, which does not cite the
  // kitchen-location fact; revision 1 rewrote both ("Geen erfpacht.") and their re-audit was clean.
  stopReason: 'clean',
  flagsByPass: [
    [
      ['verifier', 'claim_support'],
      ['verifier', 'claim_support'],
    ],
    [],
  ],
  auditedByPass: [22, 2],
});
