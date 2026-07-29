CREATE TABLE "runtime_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"agent_profile_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"runtime_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_registrations_provider_key" CHECK ("runtime_registrations"."provider" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "runtime_registrations_runtime_key_bounded" CHECK (length("runtime_registrations"."runtime_key") between 1 and 256
        and "runtime_registrations"."runtime_key" !~ '[[:cntrl:]]'),
	CONSTRAINT "runtime_registrations_version_positive" CHECK ("runtime_registrations"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "runtime_registrations" ADD CONSTRAINT "runtime_registrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_registrations" ADD CONSTRAINT "runtime_registrations_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_registrations" ADD CONSTRAINT "runtime_registrations_agent_profile_id_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_registrations_binding_unique" ON "runtime_registrations" USING btree ("project_id","actor_id","agent_profile_id","provider","runtime_key");--> statement-breakpoint
CREATE INDEX "runtime_registrations_project_actor_idx" ON "runtime_registrations" USING btree ("project_id","actor_id");