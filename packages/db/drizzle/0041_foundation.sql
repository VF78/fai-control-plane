CREATE TABLE "project_executions" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"selected_work_item_id" uuid,
	"block_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"paused_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_executions_status_valid" CHECK ("project_executions"."status" in ('stopped', 'running', 'paused', 'blocked', 'completed')),
	CONSTRAINT "project_executions_version_positive" CHECK ("project_executions"."version" > 0),
	CONSTRAINT "project_executions_selection_shape" CHECK (("project_executions"."status" = 'completed' and "project_executions"."selected_work_item_id" is null) or ("project_executions"."status" <> 'completed')),
	CONSTRAINT "project_executions_running_selection" CHECK ("project_executions"."status" <> 'running' or "project_executions"."selected_work_item_id" is not null),
	CONSTRAINT "project_executions_block_shape" CHECK (("project_executions"."status" = 'blocked' and "project_executions"."block_reason" ~ '^[a-z][a-z0-9_]{0,63}$') or ("project_executions"."status" <> 'blocked' and "project_executions"."block_reason" is null)),
	CONSTRAINT "project_executions_pause_shape" CHECK (("project_executions"."status" = 'paused') = ("project_executions"."paused_at" is not null)),
	CONSTRAINT "project_executions_completion_shape" CHECK (("project_executions"."status" = 'completed') = ("project_executions"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "project_executions" ADD CONSTRAINT "project_executions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_identity_project_unique" ON "work_items" USING btree ("id","project_id");--> statement-breakpoint
ALTER TABLE "project_executions" ADD CONSTRAINT "project_executions_selected_work_item_project_fk" FOREIGN KEY ("selected_work_item_id","project_id") REFERENCES "public"."work_items"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
