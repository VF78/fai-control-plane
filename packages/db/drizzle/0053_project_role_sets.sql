ALTER TABLE "project_memberships" RENAME COLUMN "role" TO "roles";--> statement-breakpoint
ALTER TABLE "project_memberships" ALTER COLUMN "roles" TYPE project_membership_role[] USING array["roles"]::project_membership_role[];--> statement-breakpoint
ALTER TABLE "project_executions" DROP CONSTRAINT "project_executions_selection_snapshot_shape";--> statement-breakpoint
ALTER TABLE "project_executions" ADD COLUMN "selected_responsibility_hash" text;--> statement-breakpoint
UPDATE "project_executions" SET "selected_responsibility_hash" = 'legacy-selection-stale:v1' WHERE "selected_work_item_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "project_executions" ADD CONSTRAINT "project_executions_selection_snapshot_shape" CHECK (
      ("project_executions"."selected_work_item_id" is null and "project_executions"."selected_plan_version_id" is null and
       "project_executions"."selected_work_item_version" is null and "project_executions"."selected_protocol_id" is null and
       "project_executions"."selected_protocol_version" is null and "project_executions"."selected_journey_version" is null and
       "project_executions"."selected_stage_key" is null and "project_executions"."selected_responsible_actor_id" is null and
       "project_executions"."selected_agent_profile_id" is null and "project_executions"."selected_responsibility_hash" is null)
      or
      ("project_executions"."selected_work_item_id" is not null and "project_executions"."selected_plan_version_id" is not null and
       "project_executions"."selected_work_item_version" > 0 and "project_executions"."selected_protocol_id" is not null and
       "project_executions"."selected_protocol_version" > 0 and "project_executions"."selected_journey_version" > 0 and
       "project_executions"."selected_stage_key" ~ '^[a-z][a-z0-9_]{0,63}$' and "project_executions"."selected_responsible_actor_id" is not null and
       "project_executions"."selected_responsibility_hash" is not null));--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_roles_canonical" CHECK (cardinality("project_memberships"."roles") between 1 and 5
      and (cardinality("project_memberships"."roles") < 2 or "project_memberships"."roles"[1] < "project_memberships"."roles"[2])
      and (cardinality("project_memberships"."roles") < 3 or "project_memberships"."roles"[2] < "project_memberships"."roles"[3])
      and (cardinality("project_memberships"."roles") < 4 or "project_memberships"."roles"[3] < "project_memberships"."roles"[4])
      and (cardinality("project_memberships"."roles") < 5 or "project_memberships"."roles"[4] < "project_memberships"."roles"[5]));--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_agent_role_is_singleton" CHECK (not ("project_memberships"."roles" @> array['agent']::project_membership_role[]) or "project_memberships"."roles" = array['agent']::project_membership_role[]);
