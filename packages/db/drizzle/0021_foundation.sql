ALTER TABLE "task_packets" DROP CONSTRAINT "task_packets_agent_profile_snapshot_consistent";--> statement-breakpoint
ALTER TABLE "task_packets" ADD COLUMN "agent_profile_snapshot_allowed_tools" text[];--> statement-breakpoint
ALTER TABLE "task_packets" ADD COLUMN "agent_profile_snapshot_forbidden_surfaces" text[];--> statement-breakpoint
ALTER TABLE "task_packets" ADD COLUMN "agent_profile_snapshot_enabled" boolean;--> statement-breakpoint
ALTER TABLE "task_packets" ADD CONSTRAINT "task_packets_agent_profile_snapshot_consistent" CHECK ((
        "task_packets"."agent_profile_snapshot_id" is null and
        "task_packets"."agent_profile_snapshot_runtime_id" is null and
        "task_packets"."agent_profile_snapshot_allowed_tools" is null and
        "task_packets"."agent_profile_snapshot_forbidden_surfaces" is null and
        "task_packets"."agent_profile_snapshot_enabled" is null and
        "task_packets"."agent_profile_snapshot_version" is null and
        "task_packets"."agent_profile_snapshot_hash" is null and
        "task_packets"."agent_profile_snapshot_instructions" is null and
        "task_packets"."agent_profile_snapshot_settings" is null
      ) or (
        "task_packets"."agent_profile_snapshot_id" is not null and
        "task_packets"."agent_profile_snapshot_runtime_id" is not null and
        "task_packets"."agent_profile_snapshot_allowed_tools" is not null and
        "task_packets"."agent_profile_snapshot_forbidden_surfaces" is not null and
        "task_packets"."agent_profile_snapshot_enabled" is not null and
        "task_packets"."agent_profile_snapshot_version" > 0 and
        "task_packets"."agent_profile_snapshot_hash" ~ '^[0-9a-f]{64}$' and
        "task_packets"."agent_profile_snapshot_instructions" is not null and
        "task_packets"."agent_profile_snapshot_settings" is not null
      ));