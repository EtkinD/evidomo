import { describeRecordedVerification } from './recorded-verification.ts';

// Verification scenario "qa-clean-es" (docs/model-notes.md, "Output languages: live check"): the
// recorded es draft and Q&A cards on the `nl` v2 market profile as written, audited together by
// Wonder `low` and revised by Spark (settings pinned in testing.ts). Record (one Wonder call per
// pass, one Spark call per revision):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api verification-qa-clean-es
// Structure, code checks, and the recorded outcome are asserted; wording is the models'.
describeRecordedVerification('qa-clean-es', {
  // Pass 0 audited 20 copy and 16 Q&A segments; one claim_support flag: a Q&A answer credits
  // the service costs' items to the VvE. Loop 1 revised the cards only (the copy was carried)
  // and the 2 changed segments were re-audited clean.
  stopReason: 'clean',
  flagsByPass: [[['verifier', 'claim_support']], []],
  auditedByPass: [36, 2],
});
