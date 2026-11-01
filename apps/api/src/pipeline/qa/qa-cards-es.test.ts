import { describeRecordedQa } from './recorded-qa.ts';

// Buyer Q&A cards in "es" (Spark `low`, strict json_schema, settings from the step) on the `nl`
// v2 market profile, over the post-Gate-1 facts of the recorded walkthrough, which replay from
// earlier cassettes in both modes. Record (one Spark call, ~$0.01; docs/model-notes.md,
// "Output languages: live check"):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api qa-cards-es
// Structure, provenance, the question rules, and the validator are asserted; the wording is not.
describeRecordedQa('es');
