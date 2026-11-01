import { describeRecordedVerification } from './recorded-verification.ts';

// Verification scenario "qa-clean-it" (docs/model-notes.md, "Output languages: live check"): the
// recorded it draft and Q&A cards on the `nl` v2 market profile as written, audited together by
// Wonder `low` and revised by Spark (settings pinned in testing.ts). Record (one Wonder call per
// pass, one Spark call per revision):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api verification-qa-clean-it
// Structure, code checks, and the recorded outcome are asserted; wording is the models'.
describeRecordedVerification('qa-clean-it', {
  // Pass 0 audited 18 copy and 11 Q&A segments: the validator flagged the cards' uncited
  // number words ("la seconda camera", "tra le due camere"); the verifier flagged "La VvE attiva
  // di 12 appartamenti" (the complex's 12 dwellings read as the VvE's size) and "camera da letto
  // principale" (a main-bedroom designation no fact states). Loop 1 revised the copy and the
  // cards; the 5 changed segments were re-audited clean, with every number cited.
  stopReason: 'clean',
  flagsByPass: [
    [
      ['validator', 'claim_support'],
      ['validator', 'claim_support'],
      ['verifier', 'claim_support'],
      ['verifier', 'claim_support'],
    ],
    [],
  ],
  auditedByPass: [29, 5],
});
