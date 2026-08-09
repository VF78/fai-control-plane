CREATE TABLE "project_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"configuration" jsonb NOT NULL,
	"last_error_code" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_setups_state_valid" CHECK ("project_setups"."state" in ('pending', 'in_progress', 'blocked')),
	CONSTRAINT "project_setups_version_positive" CHECK ("project_setups"."version" > 0),
	CONSTRAINT "project_setups_error_code_valid" CHECK ("project_setups"."last_error_code" is null or "project_setups"."last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "project_setups" ADD CONSTRAINT "project_setups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_setups_project_unique" ON "project_setups" USING btree ("project_id");
