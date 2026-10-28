CREATE TYPE "public"."run_step_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "run_steps" (
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" "run_step_status" DEFAULT 'queued' NOT NULL,
	"job_id" uuid NOT NULL,
	"job_retry_count" integer,
	"executions" integer DEFAULT 0 NOT NULL,
	"error" text,
	"output_artifact_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"gate_released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_steps_pkey" PRIMARY KEY("run_id","step_id","attempt"),
	CONSTRAINT "run_steps_attempt_positive" CHECK ("run_steps"."attempt" > 0),
	CONSTRAINT "run_steps_executions_nonnegative" CHECK ("run_steps"."executions" >= 0),
	CONSTRAINT "run_steps_finished_iff_closed" CHECK (("run_steps"."status" in ('completed', 'failed')) = ("run_steps"."finished_at" is not null)),
	CONSTRAINT "run_steps_failed_has_error" CHECK ("run_steps"."status" <> 'failed' or "run_steps"."error" is not null),
	CONSTRAINT "run_steps_gate_release_after_completion" CHECK ("run_steps"."gate_released_at" is null or "run_steps"."status" = 'completed')
);
--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_one_completion_key" ON "run_steps" USING btree ("run_id","step_id") WHERE "run_steps"."status" = 'completed';--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_one_open_attempt_key" ON "run_steps" USING btree ("run_id","step_id") WHERE "run_steps"."status" in ('queued', 'running');