CREATE TYPE "public"."fact_assertion" AS ENUM('stated', 'opinion');--> statement-breakpoint
DROP INDEX "artifacts_singleton_kind_key";--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "assertion" "fact_assertion" DEFAULT 'stated' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_singleton_kind_key" ON "artifacts" USING btree ("run_id","step_id","kind") WHERE "artifacts"."kind" in ('transcript', 'fact_extraction');--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_opinion_never_verified" CHECK ("facts"."assertion" = 'stated' or "facts"."status" <> 'verified');