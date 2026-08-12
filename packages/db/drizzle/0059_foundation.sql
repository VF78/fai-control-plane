DROP INDEX "project_acceptance_sessions_project_unique";--> statement-breakpoint
DROP INDEX "project_uat_protocols_project_unique";--> statement-breakpoint
ALTER TABLE "project_uat_protocols" ADD COLUMN "deployment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_uat_protocols" ADD COLUMN "deployment_lifecycle_version" integer;--> statement-breakpoint
ALTER TABLE "project_uat_protocols" ADD COLUMN "deployment_release_package_hash" text;--> statement-breakpoint
ALTER TABLE "project_uat_protocols" ADD CONSTRAINT "project_uat_protocols_deployment_scope_fk" FOREIGN KEY ("deployment_id","workspace_id","project_id","required_deployment_environment") REFERENCES "public"."deployments"("id","workspace_id","project_id","environment") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_acceptance_sessions_project_idx" ON "project_acceptance_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_uat_protocols_project_created_idx" ON "project_uat_protocols" USING btree ("project_id","created_at","id");--> statement-breakpoint
ALTER TABLE "project_uat_protocols" ADD CONSTRAINT "project_uat_protocols_deployment_binding_shape" CHECK (
    ("project_uat_protocols"."deployment_id" is null and "project_uat_protocols"."deployment_lifecycle_version" is null and
      "project_uat_protocols"."deployment_release_package_hash" is null) or
    ("project_uat_protocols"."deployment_id" is not null and "project_uat_protocols"."deployment_lifecycle_version" = 1 and
      "project_uat_protocols"."deployment_release_package_hash" is null) or
    ("project_uat_protocols"."deployment_id" is not null and "project_uat_protocols"."deployment_lifecycle_version" = 2 and
      "project_uat_protocols"."deployment_release_package_hash" ~ '^[0-9a-f]{64}$'));