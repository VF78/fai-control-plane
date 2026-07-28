DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "agent_runs") THEN
    RAISE EXCEPTION 'runner_claim_migration_requires_empty_agent_runs';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "base_commit" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "lease_token_hash" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_runs_claim_order_idx" ON "agent_runs" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_attempt_nonnegative" CHECK ("agent_runs"."attempt" >= 0);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_base_commit_sha1" CHECK ("agent_runs"."base_commit" ~ '^[0-9a-f]{40}$');--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_lease_token_hash_sha256" CHECK ("agent_runs"."lease_token_hash" is null or "agent_runs"."lease_token_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_lease_fields_together" CHECK (num_nonnulls("agent_runs"."runner_id", "agent_runs"."lease_token_hash", "agent_runs"."lease_expires_at") in (0, 3));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_runner_id_nonempty" CHECK ("agent_runs"."runner_id" is null or length("agent_runs"."runner_id") between 1 and 128);
