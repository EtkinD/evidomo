import { describeRecordedVerification } from './recorded-verification.ts';

// Verification scenario "qa-clean-tr" (docs/model-notes.md, "Output languages: live check"): the
// recorded tr draft and Q&A cards on the `nl` v2 market profile as written, audited together by
// Wonder `low` and revised by Spark (settings pinned in testing.ts). Record (one Wonder call per
// pass, one Spark call per revision):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api verification-qa-clean-tr
// Structure, code checks, and the recorded outcome are asserted; wording is the models'.
describeRecordedVerification('qa-clean-tr', {
  // Pass 0 audited 30 copy and 17 Q&A segments; three claim_support flags: the copy credits
  // the service costs' items to the VvE, one Q&A answer places the afternoon sun on the balcony,
  // and "Park ücretsizdir" (parking is free) broadens "no paid parking". Loop 1 revised the copy
  // and the cards; the 4 changed segments were re-audited clean.
  stopReason: 'clean',
  flagsByPass: [
    [
      ['verifier', 'claim_support'],
      ['verifier', 'claim_support'],
      ['verifier', 'claim_support'],
    ],
    [],
  ],
  auditedByPass: [47, 4],
});
