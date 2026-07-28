CREATE TABLE "tracker_snapshot_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"repository_external_id" text NOT NULL,
	"mode" text NOT NULL,
	"request_hash" text NOT NULL,
	"previous_external_version" text,
	"snapshot_external_version" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_snapshot_operations_mode_valid" CHECK ("tracker_snapshot_operations"."mode" in ('bootstrap', 'synchronize'))
);
--> statement-breakpoint
ALTER TABLE "tracker_snapshot_operations" ADD CONSTRAINT "tracker_snapshot_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_snapshot_operations" ADD CONSTRAINT "tracker_snapshot_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_snapshot_operations_workspace_id_unique" ON "tracker_snapshot_operations" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "tracker_snapshot_operations_repository_idx" ON "tracker_snapshot_operations" USING btree ("project_id","provider","repository_external_id","created_at");