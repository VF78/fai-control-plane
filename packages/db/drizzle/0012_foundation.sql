DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "approval_requests") THEN
    RAISE EXCEPTION 'approval_binding_migration_requires_empty_approval_requests';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "approval_requests" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "subject_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "policy_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "execution_identity" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "action_hash" text NOT NULL;--> statement-breakpoint
CREATE INDEX "approval_requests_agent_run_binding_idx" ON "approval_requests" USING btree ("agent_run_id","subject_hash","action_hash","status","expires_at");--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_execution_identity_target" CHECK ("approval_requests"."agent_run_id" is null or "approval_requests"."execution_identity" = "approval_requests"."agent_run_id");--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_subject_hash_sha256" CHECK ("approval_requests"."subject_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_action_hash_sha256" CHECK ("approval_requests"."action_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_policy_version_positive" CHECK ("approval_requests"."policy_version" > 0);--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_expiry_bounded" CHECK ("approval_requests"."expires_at" > "approval_requests"."created_at" and "approval_requests"."expires_at" <= "approval_requests"."created_at" + interval '24 hours');
