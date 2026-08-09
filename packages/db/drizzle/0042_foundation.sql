ALTER TABLE "project_executions" ADD COLUMN "selected_plan_version_id" uuid;--> statement-breakpoint
ALTER TABLE "project_executions" ADD COLUMN "selected_work_item_version" integer;--> statement-breakpoint
ALTER TABLE "project_executions" ADD COLUMN "selected_protocol_id" uuid;--> statement-breakpoint
ALTER TABLE "project_executions" ADD COLUMN "selected_protocol_version" integer;--> statement-breakpoint
ALTER TABLE "project_executions" ADD COLUMN "selected_journey_version" integer;--> statement-breakpoint
ALTER TABLE "project_executions" ADD COLUMN "selected_stage_key" text;--> statement-breakpoint
ALTER TABLE "project_executions" ADD COLUMN "selected_responsible_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "project_executions" ADD COLUMN "selected_agent_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "project_executions" ADD CONSTRAINT "project_executions_selected_work_item_plan_fk" FOREIGN KEY ("selected_work_item_id","selected_plan_version_id") REFERENCES "public"."work_items"("id","source_plan_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_executions" ADD CONSTRAINT "project_executions_selected_plan_project_fk" FOREIGN KEY ("selected_plan_version_id","project_id") REFERENCES "public"."project_plan_versions"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_executions" ADD CONSTRAINT "project_executions_selected_protocol_version_fk" FOREIGN KEY ("selected_protocol_id","selected_protocol_version") REFERENCES "public"."runbooks"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_executions" ADD CONSTRAINT "project_executions_selected_actor_fk" FOREIGN KEY ("selected_responsible_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_executions" ADD CONSTRAINT "project_executions_selected_agent_profile_fk" FOREIGN KEY ("selected_agent_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_executions" ADD CONSTRAINT "project_executions_selection_snapshot_shape" CHECK (
      ("project_executions"."selected_work_item_id" is null and "project_executions"."selected_plan_version_id" is null and
       "project_executions"."selected_work_item_version" is null and "project_executions"."selected_protocol_id" is null and
       "project_executions"."selected_protocol_version" is null and "project_executions"."selected_journey_version" is null and
       "project_executions"."selected_stage_key" is null and "project_executions"."selected_responsible_actor_id" is null and
       "project_executions"."selected_agent_profile_id" is null)
      or
      ("project_executions"."selected_work_item_id" is not null and "project_executions"."selected_plan_version_id" is not null and
       "project_executions"."selected_work_item_version" > 0 and "project_executions"."selected_protocol_id" is not null and
       "project_executions"."selected_protocol_version" > 0 and "project_executions"."selected_journey_version" > 0 and
       "project_executions"."selected_stage_key" ~ '^[a-z][a-z0-9_]{0,63}$' and "project_executions"."selected_responsible_actor_id" is not null));