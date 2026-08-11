CREATE TABLE "project_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"port" integer NOT NULL,
	"purpose" text NOT NULL,
	"adapter_key" text NOT NULL,
	"adapter_credential_ref_id" uuid NOT NULL,
	"reconciler_actor_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_environments_kind" CHECK ("project_environments"."kind" in ('development', 'production')),
	CONSTRAINT "project_environments_provider_key" CHECK ("project_environments"."provider" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "project_environments_adapter_key" CHECK ("project_environments"."adapter_key" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "project_environments_endpoint_bounded" CHECK (length("project_environments"."endpoint") between 1 and 255),
	CONSTRAINT "project_environments_port" CHECK ("project_environments"."port" between 1 and 65535),
	CONSTRAINT "project_environments_purpose_bounded" CHECK (length("project_environments"."purpose") between 1 and 240),
	CONSTRAINT "project_environments_version_positive" CHECK ("project_environments"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "subject_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "resource_type" "access_resource_type";--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "requested_level" "access_level";--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "credential_ref_id" uuid;--> statement-breakpoint
ALTER TABLE "resource_access_grants" ADD COLUMN "credential_ref_id" uuid;--> statement-breakpoint
ALTER TABLE "resource_access_grants" ADD COLUMN "approval_request_id" uuid;--> statement-breakpoint
ALTER TABLE "resource_access_grants" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
-- Legacy environment grants predate canonical environment identity, expiry and opaque
-- credential bindings. Fail closed: quarantine every such row as revoked/unobserved
-- before validating the new bounded state. The version/timestamp change preserves an
-- explicit migration trace without inventing provider evidence or orphan bindings.
UPDATE "resource_access_grants"
SET "desired_level" = 'none',
    "credential_ref_id" = NULL,
    "approval_request_id" = NULL,
    "expires_at" = NULL,
    "observed_provider" = NULL,
    "observed_external_resource_ref" = NULL,
    "observed_level" = NULL,
    "observed_at" = NULL,
    "version" = "version" + 1,
    "updated_at" = now()
WHERE "resource_type" = 'environment';--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_adapter_credential_ref_id_secret_refs_id_fk" FOREIGN KEY ("adapter_credential_ref_id") REFERENCES "public"."secret_refs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_reconciler_actor_id_actors_id_fk" FOREIGN KEY ("reconciler_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_environments_kind_unique" ON "project_environments" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "project_environments_reconciler_idx" ON "project_environments" USING btree ("reconciler_actor_id");--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_subject_actor_id_actors_id_fk" FOREIGN KEY ("subject_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_credential_ref_id_secret_refs_id_fk" FOREIGN KEY ("credential_ref_id") REFERENCES "public"."secret_refs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_access_grants" ADD CONSTRAINT "resource_access_grants_credential_ref_id_secret_refs_id_fk" FOREIGN KEY ("credential_ref_id") REFERENCES "public"."secret_refs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_access_grants" ADD CONSTRAINT "resource_access_grants_approval_request_id_access_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."access_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_environment_binding_complete" CHECK (
      ("access_requests"."resource_type" is null and "access_requests"."project_id" is null and "access_requests"."subject_actor_id" is null and
       "access_requests"."resource_id" is null and "access_requests"."requested_level" is null and "access_requests"."credential_ref_id" is null)
      or
      ("access_requests"."resource_type" = 'environment' and "access_requests"."project_id" is not null and
       "access_requests"."subject_actor_id" is not null and "access_requests"."resource_id" is not null and
       "access_requests"."requested_level" = 'write' and "access_requests"."credential_ref_id" is not null and "access_requests"."expires_at" is not null)
    );--> statement-breakpoint
ALTER TABLE "resource_access_grants" ADD CONSTRAINT "resource_access_grants_environment_binding_complete" CHECK (
      ("resource_access_grants"."resource_type" <> 'environment' and "resource_access_grants"."credential_ref_id" is null and
       "resource_access_grants"."approval_request_id" is null and "resource_access_grants"."expires_at" is null)
      or
      ("resource_access_grants"."resource_type" = 'environment' and "resource_access_grants"."desired_level" = 'none' and
       "resource_access_grants"."approval_request_id" is null and "resource_access_grants"."expires_at" is null)
      or
      ("resource_access_grants"."resource_type" = 'environment' and "resource_access_grants"."desired_level" = 'write' and
       "resource_access_grants"."credential_ref_id" is not null and "resource_access_grants"."expires_at" is not null)
    );--> statement-breakpoint
ALTER TABLE "resource_access_grants" ADD CONSTRAINT "resource_access_grants_environment_observed_level" CHECK (
      "resource_access_grants"."resource_type" <> 'environment' or "resource_access_grants"."observed_level" is null or
      "resource_access_grants"."observed_level" in ('none', 'write')
    );
