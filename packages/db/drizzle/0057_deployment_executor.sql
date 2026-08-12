CREATE TABLE "deployment_executor_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"deployment_version" integer NOT NULL,
	"registration_id" uuid NOT NULL,
	"registration_version" integer NOT NULL,
	"system_actor_id" uuid NOT NULL,
	"release_package_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"executor_id" text,
	"lease_token_hash" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completion_replay_hash" text,
	"result_hash" text,
	"observation_reference" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_executor_jobs_status_valid" CHECK ("deployment_executor_jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'rolled_back')),
	CONSTRAINT "deployment_executor_jobs_versions_positive" CHECK ("deployment_executor_jobs"."deployment_version" > 0 and "deployment_executor_jobs"."registration_version" > 0 and "deployment_executor_jobs"."version" > 0),
	CONSTRAINT "deployment_executor_jobs_observation_reference_bounded" CHECK ("deployment_executor_jobs"."observation_reference" is null or length("deployment_executor_jobs"."observation_reference") between 1 and 512),
	CONSTRAINT "deployment_executor_jobs_attempt_nonnegative" CHECK ("deployment_executor_jobs"."attempt" >= 0),
	CONSTRAINT "deployment_executor_jobs_release_package_hash_sha256" CHECK ("deployment_executor_jobs"."release_package_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "deployment_executor_jobs_lease_hash_sha256" CHECK ("deployment_executor_jobs"."lease_token_hash" is null or "deployment_executor_jobs"."lease_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "deployment_executor_jobs_executor_id_bounded" CHECK ("deployment_executor_jobs"."executor_id" is null or "deployment_executor_jobs"."executor_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	CONSTRAINT "deployment_executor_jobs_lease_fields_together" CHECK (num_nonnulls("deployment_executor_jobs"."executor_id", "deployment_executor_jobs"."lease_token_hash", "deployment_executor_jobs"."lease_expires_at") in (0, 3)),
	CONSTRAINT "deployment_executor_jobs_terminal_shape" CHECK (
      ("deployment_executor_jobs"."status" = 'queued' and "deployment_executor_jobs"."attempt" = 0 and
        num_nonnulls("deployment_executor_jobs"."executor_id", "deployment_executor_jobs"."lease_token_hash", "deployment_executor_jobs"."lease_expires_at", "deployment_executor_jobs"."heartbeat_at",
          "deployment_executor_jobs"."started_at", "deployment_executor_jobs"."completed_at", "deployment_executor_jobs"."completion_replay_hash", "deployment_executor_jobs"."result_hash",
          "deployment_executor_jobs"."observation_reference") = 0) or
      ("deployment_executor_jobs"."status" = 'running' and "deployment_executor_jobs"."attempt" > 0 and "deployment_executor_jobs"."started_at" is not null and
        "deployment_executor_jobs"."completed_at" is null and "deployment_executor_jobs"."completion_replay_hash" is null and "deployment_executor_jobs"."result_hash" is null and
        "deployment_executor_jobs"."observation_reference" is null and num_nonnulls("deployment_executor_jobs"."executor_id", "deployment_executor_jobs"."lease_token_hash",
          "deployment_executor_jobs"."lease_expires_at", "deployment_executor_jobs"."heartbeat_at") = 4) or
      ("deployment_executor_jobs"."status" in ('succeeded', 'failed', 'rolled_back') and "deployment_executor_jobs"."attempt" > 0 and
        "deployment_executor_jobs"."started_at" is not null and "deployment_executor_jobs"."completed_at" >= "deployment_executor_jobs"."started_at" and
        "deployment_executor_jobs"."executor_id" is null and "deployment_executor_jobs"."lease_token_hash" is null and "deployment_executor_jobs"."lease_expires_at" is null and
        num_nonnulls("deployment_executor_jobs"."heartbeat_at", "deployment_executor_jobs"."completed_at", "deployment_executor_jobs"."completion_replay_hash",
          "deployment_executor_jobs"."result_hash", "deployment_executor_jobs"."observation_reference") = 5 and
        "deployment_executor_jobs"."completion_replay_hash" ~ '^[0-9a-f]{64}$' and "deployment_executor_jobs"."result_hash" ~ '^[0-9a-f]{64}$' and
        length("deployment_executor_jobs"."observation_reference") between 1 and 512)
    )
);
--> statement-breakpoint
CREATE TABLE "deployment_executor_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"system_actor_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"executor_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_executor_registrations_environment_valid" CHECK ("deployment_executor_registrations"."environment" in ('development', 'staging', 'production')),
	CONSTRAINT "deployment_executor_registrations_executor_key_bounded" CHECK ("deployment_executor_registrations"."executor_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	CONSTRAINT "deployment_executor_registrations_version_positive" CHECK ("deployment_executor_registrations"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_canonical_lifecycle_shape";--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "release_package" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "release_package_hash" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "deployment_executor_registration_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "deployment_executor_registration_version" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_identity_workspace_project_unique" ON "deployments" USING btree ("id","workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_executor_registrations_identity_project_unique" ON "deployment_executor_registrations" USING btree ("id","workspace_id","project_id");--> statement-breakpoint
ALTER TABLE "deployment_executor_jobs" ADD CONSTRAINT "deployment_executor_jobs_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_executor_jobs" ADD CONSTRAINT "deployment_executor_jobs_deployment_fk" FOREIGN KEY ("deployment_id","workspace_id","project_id") REFERENCES "public"."deployments"("id","workspace_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_executor_jobs" ADD CONSTRAINT "deployment_executor_jobs_registration_fk" FOREIGN KEY ("registration_id","workspace_id","project_id") REFERENCES "public"."deployment_executor_registrations"("id","workspace_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_executor_jobs" ADD CONSTRAINT "deployment_executor_jobs_workspace_actor_fk" FOREIGN KEY ("workspace_id","system_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_executor_registrations" ADD CONSTRAINT "deployment_executor_registrations_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_executor_registrations" ADD CONSTRAINT "deployment_executor_registrations_workspace_actor_fk" FOREIGN KEY ("workspace_id","system_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_executor_jobs_deployment_unique" ON "deployment_executor_jobs" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "deployment_executor_jobs_claim_order_idx" ON "deployment_executor_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_executor_registrations_project_environment_unique" ON "deployment_executor_registrations" USING btree ("project_id","environment");--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_executor_registration_fk" FOREIGN KEY ("deployment_executor_registration_id","workspace_id","project_id") REFERENCES "public"."deployment_executor_registrations"("id","workspace_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_canonical_lifecycle_shape" CHECK ("deployments"."lifecycle_version" is null or (
      "deployments"."lifecycle_version" in (1, 2) and "deployments"."environment" in ('development', 'staging', 'production') and
      "deployments"."reference_kind" in ('artifact', 'commit', 'reference') and
      length("deployments"."revision") between 1 and 512 and "deployments"."plan_version_id" is not null and
      "deployments"."materialization_id" is not null and "deployments"."requested_by_actor_id" is not null and
      "deployments"."requested_at" is not null and "deployments"."external_ref" is null and
      "deployments"."status" in ('requested', 'approved', 'observed') and
      (("deployments"."lifecycle_version" = 1 and num_nonnulls("deployments"."release_package", "deployments"."release_package_hash",
          "deployments"."deployment_executor_registration_id", "deployments"."deployment_executor_registration_version") = 0) or
       ("deployments"."lifecycle_version" = 2 and "deployments"."reference_kind" = 'commit' and
          "deployments"."release_package" is not null and "deployments"."release_package_hash" is not null and
          "deployments"."deployment_executor_registration_id" is not null and
          "deployments"."deployment_executor_registration_version" is not null and
          jsonb_typeof("deployments"."release_package") = 'object' and "deployments"."release_package" = jsonb_build_object(
            'schemaVersion', "deployments"."release_package"->'schemaVersion',
            'sourceCommit', "deployments"."release_package"->'sourceCommit',
            'artifactReference', "deployments"."release_package"->'artifactReference',
            'artifactSha256', "deployments"."release_package"->'artifactSha256') and
          "deployments"."release_package"->'schemaVersion' = '1'::jsonb and
          jsonb_typeof("deployments"."release_package"->'sourceCommit') = 'string' and
          jsonb_typeof("deployments"."release_package"->'artifactReference') = 'string' and
          jsonb_typeof("deployments"."release_package"->'artifactSha256') = 'string' and
          "deployments"."release_package"->>'sourceCommit' ~ '^[0-9a-f]{40}$' and
          "deployments"."revision" = 'git-commit:' || ("deployments"."release_package"->>'sourceCommit') and
          "deployments"."release_package"->>'artifactSha256' ~ '^[0-9a-f]{64}$' and
          length("deployments"."release_package"->>'artifactReference') between 1 and 512 and
          "deployments"."release_package"->>'artifactReference' !~ '[[:cntrl:]]' and
          "deployments"."release_package_hash" ~ '^[0-9a-f]{64}$' and
          "deployments"."deployment_executor_registration_version" > 0))
    ));
