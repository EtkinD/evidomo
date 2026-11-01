import { describeRecordedCopy } from './recorded-copy.ts';

// Creative copy in "tr" (Spark `medium`, strict json_schema, settings from the step) on the
// `nl` v2 market profile, over the post-Gate-1 facts of the recorded walkthrough, which replay
// from earlier cassettes in both modes. Record (one Spark call, ~$0.04; docs/model-notes.md,
// "Output languages: live check"):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api creative-copy-tr
// Structure, provenance, language, and the claim validator are asserted; the wording is not.
describeRecordedCopy('tr');
