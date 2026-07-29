CREATE TABLE "agent_profile_instruction_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"instructions" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"authored_by_actor_id" uuid NOT NULL,
	"approved_by_actor_id" uuid NOT NULL,
	"rollback_of_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profile_instruction_versions_version_positive" CHECK ("agent_profile_instruction_versions"."version" > 0),
	CONSTRAINT "agent_profile_instruction_versions_content_hash_sha256" CHECK ("agent_profile_instruction_versions"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "workspace_instruction_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"instructions" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"authored_by_actor_id" uuid NOT NULL,
	"approved_by_actor_id" uuid NOT NULL,
	"rollback_of_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_instruction_versions_version_positive" CHECK ("workspace_instruction_versions"."version" > 0),
	CONSTRAINT "workspace_instruction_versions_content_hash_sha256" CHECK ("workspace_instruction_versions"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "agent_profile_instruction_versions" ADD CONSTRAINT "agent_profile_instruction_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_instruction_versions" ADD CONSTRAINT "agent_profile_instruction_versions_agent_profile_id_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_instruction_versions" ADD CONSTRAINT "agent_profile_instruction_versions_authored_by_actor_id_actors_id_fk" FOREIGN KEY ("authored_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_instruction_versions" ADD CONSTRAINT "agent_profile_instruction_versions_approved_by_actor_id_actors_id_fk" FOREIGN KEY ("approved_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_instruction_versions" ADD CONSTRAINT "agent_profile_instruction_versions_rollback_of_version_id_agent_profile_instruction_versions_id_fk" FOREIGN KEY ("rollback_of_version_id") REFERENCES "public"."agent_profile_instruction_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_instruction_versions" ADD CONSTRAINT "workspace_instruction_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_instruction_versions" ADD CONSTRAINT "workspace_instruction_versions_authored_by_actor_id_actors_id_fk" FOREIGN KEY ("authored_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_instruction_versions" ADD CONSTRAINT "workspace_instruction_versions_approved_by_actor_id_actors_id_fk" FOREIGN KEY ("approved_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_instruction_versions" ADD CONSTRAINT "workspace_instruction_versions_rollback_of_version_id_workspace_instruction_versions_id_fk" FOREIGN KEY ("rollback_of_version_id") REFERENCES "public"."workspace_instruction_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profile_instruction_versions_sequence_unique" ON "agent_profile_instruction_versions" USING btree ("agent_profile_id","version");--> statement-breakpoint
CREATE INDEX "agent_profile_instruction_versions_workspace_profile_idx" ON "agent_profile_instruction_versions" USING btree ("workspace_id","agent_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_instruction_versions_sequence_unique" ON "workspace_instruction_versions" USING btree ("workspace_id","version");