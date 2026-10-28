CREATE TYPE "public"."decision_choice" AS ENUM('accept', 'edit', 'remove', 'reject');--> statement-breakpoint
CREATE TYPE "public"."decision_target_kind" AS ENUM('fact', 'claim', 'artifact');--> statement-breakpoint
CREATE TYPE "public"."fact_source_kind" AS ENUM('form', 'transcript_turn', 'photo_region');--> statement-breakpoint
CREATE TYPE "public"."fact_status" AS ENUM('candidate', 'verified', 'conflicted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."gate" AS ENUM('fact_conflicts', 'claim_audit');--> statement-breakpoint
CREATE TYPE "public"."material_kind" AS ENUM('photo', 'voice_memo');--> statement-breakpoint
CREATE TYPE "public"."material_status" AS ENUM('uploaded', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'awaiting_gate', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."validator_result" AS ENUM('pass', 'fail');--> statement-breakpoint
CREATE TYPE "public"."verifier_verdict" AS ENUM('supported', 'unsupported', 'flagged');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb,
	"storage_key" text,
	"mime_type" text,
	"usage_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "artifacts_has_payload" CHECK ("artifacts"."content" is not null or "artifacts"."storage_key" is not null),
	CONSTRAINT "artifacts_file_has_mime" CHECK ("artifacts"."storage_key" is null or "artifacts"."mime_type" is not null)
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"segment_index" integer NOT NULL,
	"text" text NOT NULL,
	"fact_ids" text[] NOT NULL,
	"validator_result" "validator_result",
	"validator_details" jsonb,
	"verifier_verdict" "verifier_verdict",
	"verifier_details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_artifact_segment_key" UNIQUE("artifact_id","segment_index"),
	CONSTRAINT "claims_segment_index_nonnegative" CHECK ("claims"."segment_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"gate" "gate" NOT NULL,
	"target_kind" "decision_target_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"choice" "decision_choice" NOT NULL,
	"edited_value" jsonb,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_one_per_target_key" UNIQUE("run_id","gate","target_kind","target_id"),
	CONSTRAINT "decisions_edit_has_value" CHECK (("decisions"."choice" = 'edit') = ("decisions"."edited_value" is not null))
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"unit" text,
	"basis" text,
	"source_kind" "fact_source_kind" NOT NULL,
	"source_ref" jsonb NOT NULL,
	"status" "fact_status" DEFAULT 'candidate' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "material_kind" NOT NULL,
	"status" "material_status" DEFAULT 'uploaded' NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "materials_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "materials_size_bytes_positive" CHECK ("materials"."size_bytes" > 0),
	CONSTRAINT "materials_sha256_hex" CHECK ("materials"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"office_profile" jsonb NOT NULL,
	"market_profile_id" text NOT NULL,
	"market_profile_version" integer NOT NULL,
	"output_language" text NOT NULL,
	"fact_form" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "project_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_market_profile_version_positive" CHECK ("projects"."market_profile_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "run_events_pkey" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "run_events_seq_positive" CHECK ("run_events"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"service_id" text NOT NULL,
	"service_version" integer NOT NULL,
	"market_profile_id" text NOT NULL,
	"market_profile_version" integer NOT NULL,
	"output_language" text NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"gate" "gate",
	"current_step_id" text,
	"failure_reason" text,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_versions_positive" CHECK ("runs"."service_version" > 0 and "runs"."market_profile_version" > 0),
	CONSTRAINT "runs_gate_iff_awaiting" CHECK (("runs"."status" = 'awaiting_gate') = ("runs"."gate" is not null)),
	CONSTRAINT "runs_failed_has_reason" CHECK ("runs"."status" <> 'failed' or "runs"."failure_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"step_id" text,
	"model_id" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"audio_seconds" numeric(10, 3) DEFAULT '0' NOT NULL,
	"images" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(12, 8) NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledger_units_nonnegative" CHECK ("usage_ledger"."input_tokens" >= 0 and "usage_ledger"."output_tokens" >= 0 and "usage_ledger"."reasoning_tokens" >= 0 and "usage_ledger"."audio_seconds" >= 0 and "usage_ledger"."images" >= 0),
	CONSTRAINT "usage_ledger_cost_nonnegative" CHECK ("usage_ledger"."estimated_cost_usd" >= 0),
	CONSTRAINT "usage_ledger_latency_nonnegative" CHECK ("usage_ledger"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_run_id_idx" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "facts_run_id_key_idx" ON "facts" USING btree ("run_id","key");--> statement-breakpoint
CREATE INDEX "materials_project_id_idx" ON "materials" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_owner_id_idx" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "runs_project_id_idx" ON "runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_run_id_idx" ON "usage_ledger" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_created_at_idx" ON "usage_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));