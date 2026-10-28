import { describeRecordedCopy } from './recorded-copy.ts';

// Creative copy in "nl" (Spark `medium`, strict json_schema, settings from the step) over the
// post-Gate-1 facts of the recorded walkthrough, which replay from earlier cassettes in both
// modes. Record (one Spark call, ~$0.04; docs/model-notes.md, P3-01):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api creative-copy-nl
// Structure, provenance, and language are asserted; the wording is the model's and is not.
describeRecordedCopy('nl');
