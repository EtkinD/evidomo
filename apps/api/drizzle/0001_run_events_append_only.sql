-- run_events is append-only: it is the audit trail and the source for demo replay.
-- Direct UPDATE and DELETE are rejected. Deletes cascading from runs (project hard delete)
-- are allowed: they execute inside the foreign-key trigger, so the trigger depth is above 1.
CREATE FUNCTION "run_events_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'run_events is append-only (% rejected)', TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "run_events_append_only"
	BEFORE UPDATE OR DELETE ON "run_events"
	FOR EACH ROW EXECUTE FUNCTION "run_events_reject_mutation"();
