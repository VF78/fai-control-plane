ALTER TABLE "agent_profiles" ADD COLUMN "instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "config_hash" text DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_packets" ADD COLUMN "agent_profile_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "task_packets" ADD COLUMN "agent_profile_snapshot_runtime_id" text;--> statement-breakpoint
ALTER TABLE "task_packets" ADD COLUMN "agent_profile_snapshot_version" integer;--> statement-breakpoint
ALTER TABLE "task_packets" ADD COLUMN "agent_profile_snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "task_packets" ADD COLUMN "agent_profile_snapshot_instructions" text;--> statement-breakpoint
ALTER TABLE "task_packets" ADD COLUMN "agent_profile_snapshot_settings" jsonb;--> statement-breakpoint
ALTER TABLE "task_packets" ADD CONSTRAINT "task_packets_agent_profile_snapshot_id_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_snapshot_id") REFERENCES "public"."agent_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_version_positive" CHECK ("agent_profiles"."version" > 0);--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_config_hash_sha256" CHECK ("agent_profiles"."config_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "task_packets" ADD CONSTRAINT "task_packets_agent_profile_snapshot_consistent" CHECK ((
        "task_packets"."agent_profile_snapshot_id" is null and
        "task_packets"."agent_profile_snapshot_runtime_id" is null and
        "task_packets"."agent_profile_snapshot_version" is null and
        "task_packets"."agent_profile_snapshot_hash" is null and
        "task_packets"."agent_profile_snapshot_instructions" is null and
        "task_packets"."agent_profile_snapshot_settings" is null
      ) or (
        "task_packets"."agent_profile_snapshot_id" is not null and
        "task_packets"."agent_profile_snapshot_runtime_id" is not null and
        "task_packets"."agent_profile_snapshot_version" > 0 and
        "task_packets"."agent_profile_snapshot_hash" ~ '^[0-9a-f]{64}$' and
        "task_packets"."agent_profile_snapshot_instructions" is not null and
        "task_packets"."agent_profile_snapshot_settings" is not null
      ));