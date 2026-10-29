import { describeRecordedVerification } from './recorded-verification.ts';

// Verification scenario "qa-en" (docs/model-notes.md, P3-03): the recorded P3-01 en draft and
// the recorded P3-03 en Q&A cards with seeded defects, audited together by Wonder `low`; flagged
// cards are revised by the Q&A step's own function (Spark `low`, settings pinned in testing.ts).
// Record (one Wonder call per pass, one Spark call per revision; ~$0.05-0.15):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api verification-qa-en
// Structure, code checks, and the recorded outcome are asserted; wording is the models'.
describeRecordedVerification('qa-en', {
  // Pass 0 audited 17 copy and 18 Q&A segments in one call: the validator's 8 m² finding and
  // every seeded Q&A defect (the exclusionary question flagged on its card's first answer
  // segment), plus "Parking is available" in the copy. Loop 1 revised the copy and the cards
  // (one Spark call each); the 5 changed segments were re-audited clean.
  stopReason: 'clean',
  flagsByPass: [
    [
      ['validator', 'claim_support'],
      ['verifier', 'claim_support'],
      ['verifier', 'exclusionary'],
      ['verifier', 'claim_support'],
      ['verifier', 'investment_promise'],
    ],
    [],
  ],
  auditedByPass: [35, 5],
});
