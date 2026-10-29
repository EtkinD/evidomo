import { describeRecordedVerification } from './recorded-verification.ts';

// Verification scenario "qa-clean-en" (docs/model-notes.md, P3-03): the recorded P3-01 en draft
// and the recorded P3-03 en Q&A cards as written, audited together by Wonder `low` (settings
// pinned in testing.ts); the verification integration test replays the same requests. Record:
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api verification-qa-clean-en
// Structure, code checks, and the recorded outcome are asserted; wording is the models'.
describeRecordedVerification('qa-clean-en', {
  // Pass 0 audited 17 copy and 18 Q&A segments: no Q&A flag; one copy flag ("Parking is
  // available" as an unstated status; loop-en passed the same segment, so it is a borderline
  // call). Loop 1 revised the copy only, the cards stayed as they were (carried), and the one
  // changed segment was re-audited clean.
  stopReason: 'clean',
  flagsByPass: [[['verifier', 'claim_support']], []],
  auditedByPass: [35, 1],
});
