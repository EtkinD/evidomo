import { describeRecordedVerification } from './recorded-verification.ts';

// Verification scenario "seeded-en" (docs/model-notes.md, P3-06): the recorded P3-01 draft, audited by
// Wonder `low` and revised by Spark `medium` (settings pinned in testing.ts). Record (one Wonder
// call per pass, one Spark call per revision; ~$0.05-0.20):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api verification-seeded-en
// Structure, code checks, and the recorded outcome are asserted; wording is the models'.
describeRecordedVerification('seeded-en', {
  // Pass 0: the validator's 15 m² finding, then the verifier caught every seeded defect (also
  // the 15 m², "perfect" as a superlative, and "Parking is available" in an unseeded segment as
  // unsupported); revision 1 rewrote the six flagged segments and their re-audit was clean.
  stopReason: 'clean',
  flagsByPass: [
    [
      ['validator', 'claim_support'],
      ['verifier', 'unverifiable_superlative'],
      ['verifier', 'investment_promise'],
      ['verifier', 'area_basis'],
      ['verifier', 'claim_support'],
      ['verifier', 'unverifiable_superlative'],
      ['verifier', 'exclusionary'],
      ['verifier', 'claim_support'],
    ],
    [],
  ],
  auditedByPass: [17, 6],
});
