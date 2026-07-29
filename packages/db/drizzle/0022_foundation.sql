CREATE TYPE "public"."access_level" AS ENUM('none', 'read', 'write', 'admin');--> statement-breakpoint
CREATE TYPE "public"."access_resource_type" AS ENUM('repository', 'tracker', 'internal_chat', 'client_chat', 'environment', 'control_plane_action');--> statement-breakpoint
CREATE TYPE "public"."project_membership_role" AS ENUM('workspace_owner', 'project_owner', 'contributor', 'reviewer', 'client_viewer', 'agent');--> statement-breakpoint
CREATE TABLE "actor_external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_subject" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_external_identities_provider_key" CHECK ("actor_external_identities"."provider" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "actor_external_identities_version_positive" CHECK ("actor_external_identities"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"role" "project_membership_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memberships_version_positive" CHECK ("project_memberships"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "resource_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"resource_type" "access_resource_type" NOT NULL,
	"resource_id" uuid NOT NULL,
	"desired_level" "access_level" NOT NULL,
	"observed_provider" text,
	"observed_external_resource_ref" text,
	"observed_level" "access_level",
	"observed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_access_grants_observation_complete" CHECK (("resource_access_grants"."observed_provider" is null
          and "resource_access_grants"."observed_external_resource_ref" is null
          and "resource_access_grants"."observed_level" is null
          and "resource_access_grants"."observed_at" is null)
        or ("resource_access_grants"."observed_provider" is not null
          and "resource_access_grants"."observed_external_resource_ref" is not null
          and "resource_access_grants"."observed_level" is not null
          and "resource_access_grants"."observed_at" is not null)),
	CONSTRAINT "resource_access_grants_observed_provider_key" CHECK ("resource_access_grants"."observed_provider" is null
        or "resource_access_grants"."observed_provider" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "resource_access_grants_version_positive" CHECK ("resource_access_grants"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "actor_external_identities" ADD CONSTRAINT "actor_external_identities_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_access_grants" ADD CONSTRAINT "resource_access_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_access_grants" ADD CONSTRAINT "resource_access_grants_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "actor_external_identities_provider_subject_unique" ON "actor_external_identities" USING btree ("provider","external_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "actor_external_identities_actor_provider_unique" ON "actor_external_identities" USING btree ("actor_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "project_memberships_project_actor_unique" ON "project_memberships" USING btree ("project_id","actor_id");--> statement-breakpoint
CREATE INDEX "project_memberships_actor_idx" ON "project_memberships" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_access_grants_binding_unique" ON "resource_access_grants" USING btree ("project_id","actor_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "resource_access_grants_actor_project_idx" ON "resource_access_grants" USING btree ("actor_id","project_id");