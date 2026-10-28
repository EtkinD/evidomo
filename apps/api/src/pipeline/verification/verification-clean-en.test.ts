import { describeRecordedVerification } from './recorded-verification.ts';

// Verification scenario "clean-en" (docs/model-notes.md, P3-06): the recorded P3-01 en draft
// with its one flagged segment as the loop-en revision rewrote it, audited in full by Wonder
// `low`: the cost of a clean first pass. Record (one Wonder call, ~$0.025):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api verification-clean-en
// Structure, code checks, and the recorded outcome are asserted; wording is the model's.
describeRecordedVerification('clean-en', {
  stopReason: 'clean',
  flagsByPass: [[]],
  auditedByPass: [17],
});
