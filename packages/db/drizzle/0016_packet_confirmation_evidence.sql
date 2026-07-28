DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "task_packets") OR EXISTS (SELECT 1 FROM "agent_runs") THEN
    RAISE EXCEPTION 'packet_confirmation_evidence_migration_requires_empty_task_packets_and_agent_runs';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "confirmed_packet_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "task_packets" ADD COLUMN "work_item_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_confirmed_packet_hash_sha256" CHECK ("agent_runs"."confirmed_packet_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "task_packets" ADD CONSTRAINT "task_packets_work_item_version_positive" CHECK ("task_packets"."work_item_version" > 0);
