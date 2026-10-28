// Drizzle table definitions (docs/architecture.md §8).
//
// Deletion model: every project-derived row cascades from `projects` (and `projects` from
// `users`), so deleting a project hard-deletes its materials, runs, events, facts,
// artifacts, claims, and decisions in one statement. The usage ledger is the exception: it
// holds no customer content and keeps cost accounting (daily caps) intact, so its run
// reference is set to NULL instead.
import {
  DECISION_CHOICES,
  DECISION_TARGET_KINDS,
  FACT_SOURCE_KINDS,
  FACT_STATUSES,
  GATES,
  MATERIAL_KINDS,
  MATERIAL_STATUSES,
  PROJECT_STATUSES,
  RUN_STATUSES,
  VALIDATOR_RESULTS,
  VERIFIER_VERDICTS,
} from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const projectStatus = pgEnum('project_status', PROJECT_STATUSES);
export const materialKind = pgEnum('material_kind', MATERIAL_KINDS);
export const materialStatus = pgEnum('material_status', MATERIAL_STATUSES);
export const runStatus = pgEnum('run_status', RUN_STATUSES);
export const gate = pgEnum('gate', GATES);
export const factStatus = pgEnum('fact_status', FACT_STATUSES);
export const factSourceKind = pgEnum('fact_source_kind', FACT_SOURCE_KINDS);
export const validatorResult = pgEnum('validator_result', VALIDATOR_RESULTS);
export const verifierVerdict = pgEnum('verifier_verdict', VERIFIER_VERDICTS);
export const decisionTargetKind = pgEnum('decision_target_kind', DECISION_TARGET_KINDS);
export const decisionChoice = pgEnum('decision_choice', DECISION_CHOICES);

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stored normalized (trimmed, lower-case) by the repository.
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_lower_key').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    // A hash of the session token; the raw token only ever lives in the cookie.
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    officeProfile: jsonb('office_profile').notNull(),
    marketProfileId: text('market_profile_id').notNull(),
    marketProfileVersion: integer('market_profile_version').notNull(),
    outputLanguage: text('output_language').notNull(),
    // Fact form values keyed by field; validated against the market profile by the caller.
    factForm: jsonb('fact_form').notNull().default({}),
    status: projectStatus('status').notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('projects_owner_id_idx').on(t.ownerId),
    check('projects_market_profile_version_positive', sql`${t.marketProfileVersion} > 0`),
  ],
);

export const materials = pgTable(
  'materials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: materialKind('kind').notNull(),
    status: materialStatus('status').notNull().default('uploaded'),
    storageKey: text('storage_key').notNull().unique(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    // Processing output such as dimensions or duration.
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('materials_project_id_idx').on(t.projectId),
    check('materials_size_bytes_positive', sql`${t.sizeBytes} > 0`),
    check('materials_sha256_hex', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    serviceId: text('service_id').notNull(),
    serviceVersion: integer('service_version').notNull(),
    marketProfileId: text('market_profile_id').notNull(),
    marketProfileVersion: integer('market_profile_version').notNull(),
    outputLanguage: text('output_language').notNull(),
    status: runStatus('status').notNull().default('queued'),
    // The gate the run is paused at; set exactly when status = 'awaiting_gate'.
    gate: gate('gate'),
    currentStepId: text('current_step_id'),
    failureReason: text('failure_reason'),
    // Last allocated run_events.seq; incrementing it row-locks the run, which serializes appends.
    lastEventSeq: integer('last_event_seq').notNull().default(0),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('runs_project_id_idx').on(t.projectId),
    check('runs_versions_positive', sql`${t.serviceVersion} > 0 and ${t.marketProfileVersion} > 0`),
    check('runs_gate_iff_awaiting', sql`(${t.status} = 'awaiting_gate') = (${t.gate} is not null)`),
    check('runs_failed_has_reason', sql`${t.status} <> 'failed' or ${t.failureReason} is not null`),
  ],
);

export const runEvents = pgTable(
  'run_events',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    // clock_timestamp(), not now(): several events appended in one transaction must keep
    // distinct times for replay with original timing.
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ name: 'run_events_pkey', columns: [t.runId, t.seq] }),
    check('run_events_seq_positive', sql`${t.seq} > 0`),
  ],
);

export const facts = pgTable(
  'facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    unit: text('unit'),
    // Measurement basis, e.g. NEN2580 or gross/net; compared together with value and unit.
    basis: text('basis'),
    sourceKind: factSourceKind('source_kind').notNull(),
    sourceRef: jsonb('source_ref').notNull(),
    status: factStatus('status').notNull().default('candidate'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('facts_run_id_key_idx').on(t.runId, t.key)],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    kind: text('kind').notNull(),
    content: jsonb('content'),
    storageKey: text('storage_key').unique(),
    mimeType: text('mime_type'),
    // usage_ledger IDs of the model calls that produced this artifact. No FK: ledger rows
    // outlive projects (see the deletion model above).
    usageIds: uuid('usage_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
  },
  (t) => [
    index('artifacts_run_id_idx').on(t.runId),
    check('artifacts_has_payload', sql`${t.content} is not null or ${t.storageKey} is not null`),
    check('artifacts_file_has_mime', sql`${t.storageKey} is null or ${t.mimeType} is not null`),
  ],
);

export const claims = pgTable(
  'claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    segmentIndex: integer('segment_index').notNull(),
    text: text('text').notNull(),
    // The fact IDs exactly as cited by the model. Text, not uuid with an FK: the validator
    // must be able to record (and reject) citations of unknown or malformed IDs.
    factIds: text('fact_ids').array().notNull(),
    validatorResult: validatorResult('validator_result'),
    validatorDetails: jsonb('validator_details'),
    verifierVerdict: verifierVerdict('verifier_verdict'),
    verifierDetails: jsonb('verifier_details'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('claims_artifact_segment_key').on(t.artifactId, t.segmentIndex),
    check('claims_segment_index_nonnegative', sql`${t.segmentIndex} >= 0`),
  ],
);

export const decisions = pgTable(
  'decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    gate: gate('gate').notNull(),
    targetKind: decisionTargetKind('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    choice: decisionChoice('choice').notNull(),
    editedValue: jsonb('edited_value'),
    decidedBy: uuid('decided_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    unique('decisions_one_per_target_key').on(t.runId, t.gate, t.targetKind, t.targetId),
    check('decisions_edit_has_value', sql`(${t.choice} = 'edit') = (${t.editedValue} is not null)`),
  ],
);

export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL for calls outside a run (e.g. evaluation) and after the run's project is deleted.
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    stepId: text('step_id'),
    modelId: text('model_id').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    // As reported by the API; reasoning_tokens is recorded separately and billed at output rates.
    outputTokens: integer('output_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    audioSeconds: numeric('audio_seconds', { precision: 10, scale: 3, mode: 'string' })
      .notNull()
      .default('0'),
    images: integer('images').notNull().default(0),
    // Exact decimal: per-token prices need 8 fraction digits ($1.25 / 1M tokens = 0.00000125).
    estimatedCostUsd: numeric('estimated_cost_usd', {
      precision: 12,
      scale: 8,
      mode: 'string',
    }).notNull(),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('usage_ledger_run_id_idx').on(t.runId),
    index('usage_ledger_created_at_idx').on(t.createdAt),
    check(
      'usage_ledger_units_nonnegative',
      sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.reasoningTokens} >= 0 and ${t.audioSeconds} >= 0 and ${t.images} >= 0`,
    ),
    check('usage_ledger_cost_nonnegative', sql`${t.estimatedCostUsd} >= 0`),
    check('usage_ledger_latency_nonnegative', sql`${t.latencyMs} >= 0`),
  ],
);
