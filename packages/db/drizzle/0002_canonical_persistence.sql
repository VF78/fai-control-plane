CREATE TYPE "public"."audit_outcome" AS ENUM('succeeded', 'failed', 'rejected', 'approval_required');--> statement-breakpoint
CREATE TYPE "public"."command_receipt_state" AS ENUM('claimed', 'completed');--> statement-breakpoint
ALTER TABLE "command_receipts" ALTER COLUMN "aggregate_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "command_receipts" ALTER COLUMN "result" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "command_id" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "outcome" "audit_outcome";--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "reason_code" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "expected_version" integer;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "result_version" integer;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
UPDATE "audit_events"
SET "command_id" = 'legacy:' || "id"::text,
    "occurred_at" = "created_at";--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "command_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "occurred_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD COLUMN "command_id" text;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD COLUMN "correlation_id" text;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD COLUMN "state" "command_receipt_state";--> statement-breakpoint
ALTER TABLE "command_receipts" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "command_receipts"
SET "request_hash" = 'legacy:' || "id"::text,
    "command_id" = "id"::text,
    "correlation_id" = 'legacy:' || "id"::text,
    "state" = 'completed',
    "completed_at" = "created_at";--> statement-breakpoint
ALTER TABLE "command_receipts" ALTER COLUMN "request_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "command_receipts" ALTER COLUMN "command_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "command_receipts" ALTER COLUMN "correlation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "command_receipts" ALTER COLUMN "state" SET DEFAULT 'claimed';--> statement-breakpoint
ALTER TABLE "command_receipts" ALTER COLUMN "state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_version_positive" CHECK ("access_requests"."version" > 0);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_version_positive" CHECK ("agent_runs"."version" > 0);--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_version_positive" CHECK ("approval_requests"."version" > 0);--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_completion_consistent" CHECK (("command_receipts"."state" = 'claimed' and "command_receipts"."result" is null and "command_receipts"."completed_at" is null)
        or ("command_receipts"."state" = 'completed' and "command_receipts"."result" is not null and "command_receipts"."completed_at" is not null));--> statement-breakpoint
CREATE FUNCTION "public"."reject_immutable_row_change_0002"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION '% is immutable: % is not allowed', TG_TABLE_NAME, TG_OP
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "task_packets_reject_update_delete"
BEFORE UPDATE OR DELETE ON "task_packets"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_immutable_row_change_0002"();--> statement-breakpoint
CREATE TRIGGER "audit_events_reject_update_delete"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_immutable_row_change_0002"();
