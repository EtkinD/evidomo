import { describeRecordedVerification } from './recorded-verification.ts';

// Verification scenario "loop-en" (docs/model-notes.md, P3-06): the recorded P3-01 draft, audited by
// Wonder `low` and revised by Spark `medium` (settings pinned in testing.ts). Record (one Wonder
// call per pass, one Spark call per revision; ~$0.05-0.20):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api verification-loop-en
// Structure, code checks, and the recorded outcome are asserted; wording is the models'.
describeRecordedVerification('loop-en', {
  // Since the vision prompt version 2 re-recording, the en draft passed its first audit without
  // a flag, so no revision was made (loop-nl and seeded-en still exercise the revision loop).
  stopReason: 'clean',
  flagsByPass: [[]],
  auditedByPass: [17],
});
