CREATE UNIQUE INDEX "actors_workspace_id_unique" ON "actors" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_id_unique" ON "projects" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE TABLE "project_plan_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"definition" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"approved_by_actor_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_plan_drafts_state" CHECK ("project_plan_drafts"."state" in ('draft', 'approved')),
	CONSTRAINT "project_plan_drafts_revision_positive" CHECK ("project_plan_drafts"."revision" > 0),
	CONSTRAINT "project_plan_drafts_hash" CHECK ("project_plan_drafts"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_plan_drafts_definition_object" CHECK (jsonb_typeof("project_plan_drafts"."definition") = 'object'),
	CONSTRAINT "project_plan_drafts_approval_shape" CHECK (("project_plan_drafts"."state" = 'draft' and "project_plan_drafts"."approved_by_actor_id" is null and "project_plan_drafts"."approved_at" is null) or ("project_plan_drafts"."state" = 'approved' and "project_plan_drafts"."approved_by_actor_id" is not null and "project_plan_drafts"."approved_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_drafts_identity_scope_unique" ON "project_plan_drafts" USING btree ("id","workspace_id","project_id");--> statement-breakpoint
CREATE TABLE "project_plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"source_manifest" jsonb NOT NULL,
	"simulation" jsonb NOT NULL,
	"approved_by_actor_id" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_plan_versions_positive" CHECK ("project_plan_versions"."version" > 0 and "project_plan_versions"."source_revision" > 0),
	CONSTRAINT "project_plan_versions_hash" CHECK ("project_plan_versions"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_plan_versions_definition_object" CHECK (jsonb_typeof("project_plan_versions"."definition") = 'object'),
	CONSTRAINT "project_plan_versions_source_manifest_array" CHECK (jsonb_typeof("project_plan_versions"."source_manifest") = 'array'),
	CONSTRAINT "project_plan_versions_simulation_object" CHECK (jsonb_typeof("project_plan_versions"."simulation") = 'object')
);
--> statement-breakpoint
CREATE TABLE "project_source_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"content" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_source_artifacts_media_type" CHECK ("project_source_artifacts"."media_type" in ('text/plain', 'text/markdown', 'application/json')),
	CONSTRAINT "project_source_artifacts_content_bounded" CHECK (octet_length("project_source_artifacts"."content") between 1 and 262144 and "project_source_artifacts"."size_bytes" = octet_length("project_source_artifacts"."content")),
	CONSTRAINT "project_source_artifacts_sha256" CHECK ("project_source_artifacts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_source_artifacts_provenance_object" CHECK (jsonb_typeof("project_source_artifacts"."provenance") = 'object'),
	CONSTRAINT "project_source_artifacts_version_one" CHECK ("project_source_artifacts"."version" = 1)
);
--> statement-breakpoint
ALTER TABLE "project_plan_drafts" ADD CONSTRAINT "project_plan_drafts_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_drafts" ADD CONSTRAINT "project_plan_drafts_workspace_created_actor_fk" FOREIGN KEY ("workspace_id","created_by_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_drafts" ADD CONSTRAINT "project_plan_drafts_workspace_approved_actor_fk" FOREIGN KEY ("workspace_id","approved_by_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_versions" ADD CONSTRAINT "project_plan_versions_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_versions" ADD CONSTRAINT "project_plan_versions_plan_scope_fk" FOREIGN KEY ("plan_id","workspace_id","project_id") REFERENCES "public"."project_plan_drafts"("id","workspace_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_versions" ADD CONSTRAINT "project_plan_versions_workspace_actor_fk" FOREIGN KEY ("workspace_id","approved_by_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_artifacts" ADD CONSTRAINT "project_source_artifacts_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_artifacts" ADD CONSTRAINT "project_source_artifacts_workspace_actor_fk" FOREIGN KEY ("workspace_id","created_by_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_drafts_project_active_unique" ON "project_plan_drafts" USING btree ("project_id") WHERE "project_plan_drafts"."state" = 'draft';--> statement-breakpoint
CREATE INDEX "project_plan_drafts_project_updated_idx" ON "project_plan_drafts" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_versions_project_version_unique" ON "project_plan_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_versions_plan_unique" ON "project_plan_versions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "project_plan_versions_project_created_idx" ON "project_plan_versions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_source_artifacts_project_created_idx" ON "project_source_artifacts" USING btree ("project_id","created_at");
