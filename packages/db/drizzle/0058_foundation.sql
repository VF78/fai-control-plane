ALTER TABLE "deployment_executor_jobs" DROP CONSTRAINT "deployment_executor_jobs_deployment_fk";
--> statement-breakpoint
ALTER TABLE "deployment_executor_jobs" DROP CONSTRAINT "deployment_executor_jobs_registration_fk";
--> statement-breakpoint
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_executor_registration_fk";
--> statement-breakpoint
DROP INDEX "deployment_executor_registrations_identity_project_unique";--> statement-breakpoint
DROP INDEX "deployments_identity_workspace_project_unique";--> statement-breakpoint
ALTER TABLE "deployment_executor_jobs" ADD COLUMN "environment" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_executor_registrations_identity_project_environment_unique" ON "deployment_executor_registrations" USING btree ("id","workspace_id","project_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_identity_workspace_project_environment_unique" ON "deployments" USING btree ("id","workspace_id","project_id","environment");--> statement-breakpoint
ALTER TABLE "deployment_executor_jobs" ADD CONSTRAINT "deployment_executor_jobs_deployment_fk" FOREIGN KEY ("deployment_id","workspace_id","project_id","environment") REFERENCES "public"."deployments"("id","workspace_id","project_id","environment") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_executor_jobs" ADD CONSTRAINT "deployment_executor_jobs_registration_fk" FOREIGN KEY ("registration_id","workspace_id","project_id","environment") REFERENCES "public"."deployment_executor_registrations"("id","workspace_id","project_id","environment") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_executor_registration_fk" FOREIGN KEY ("deployment_executor_registration_id","workspace_id","project_id","environment") REFERENCES "public"."deployment_executor_registrations"("id","workspace_id","project_id","environment") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_executor_jobs_one_running_per_target" ON "deployment_executor_jobs" USING btree ("workspace_id","project_id","environment") WHERE "deployment_executor_jobs"."status" = 'running';--> statement-breakpoint
ALTER TABLE "deployment_executor_jobs" ADD CONSTRAINT "deployment_executor_jobs_environment_valid" CHECK ("deployment_executor_jobs"."environment" in ('development', 'staging', 'production'));
