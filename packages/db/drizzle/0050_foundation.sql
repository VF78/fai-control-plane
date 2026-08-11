ALTER TABLE "deployments" DROP CONSTRAINT "deployments_approved_by_actor_id_actors_id_fk";
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
UPDATE "deployments" SET "workspace_id" = "projects"."workspace_id"
FROM "projects" WHERE "deployments"."project_id" = "projects"."id";--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "reference_kind" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "plan_version_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "materialization_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "requested_by_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "observed_by_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "observed_result" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "smoke_checks" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "rollback_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "lifecycle_version" integer;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_requested_by_actor_id_actors_id_fk" FOREIGN KEY ("requested_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_observed_by_actor_id_actors_id_fk" FOREIGN KEY ("observed_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_materializations_identity_scope_unique" ON "project_plan_materializations" USING btree ("id","workspace_id","project_id","plan_version_id");--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_work_item_fk" FOREIGN KEY ("project_id","work_item_id") REFERENCES "public"."work_items"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_plan_scope_fk" FOREIGN KEY ("workspace_id","project_id","plan_version_id") REFERENCES "public"."project_plan_versions"("workspace_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_materialization_scope_fk" FOREIGN KEY ("materialization_id","workspace_id","project_id","plan_version_id") REFERENCES "public"."project_plan_materializations"("id","workspace_id","project_id","plan_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workspace_requested_actor_fk" FOREIGN KEY ("workspace_id","requested_by_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workspace_approved_actor_fk" FOREIGN KEY ("workspace_id","approved_by_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workspace_observed_actor_fk" FOREIGN KEY ("workspace_id","observed_by_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_approved_by_actor_id_actors_id_fk" FOREIGN KEY ("approved_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_version_positive" CHECK ("deployments"."version" > 0);--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_canonical_lifecycle_shape" CHECK ("deployments"."lifecycle_version" is null or (
      "deployments"."lifecycle_version" = 1 and "deployments"."environment" in ('development', 'staging', 'production') and
      "deployments"."reference_kind" in ('artifact', 'commit', 'reference') and
      length("deployments"."revision") between 1 and 512 and "deployments"."plan_version_id" is not null and
      "deployments"."materialization_id" is not null and "deployments"."requested_by_actor_id" is not null and
      "deployments"."requested_at" is not null and "deployments"."external_ref" is null and
      "deployments"."status" in ('requested', 'approved', 'observed')
    ));--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_canonical_approval_shape" CHECK ("deployments"."lifecycle_version" is null or (
      ("deployments"."status" = 'requested' and "deployments"."environment" = 'production' and
        "deployments"."approved_by_actor_id" is null and "deployments"."approved_at" is null) or
      ("deployments"."status" in ('approved', 'observed') and "deployments"."approved_by_actor_id" is not null and
        "deployments"."approved_at" is not null)
    ));--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_canonical_observation_shape" CHECK ("deployments"."lifecycle_version" is null or (
      ("deployments"."status" <> 'observed' and "deployments"."observed_by_actor_id" is null and "deployments"."observed_at" is null and
        "deployments"."observed_result" is null and "deployments"."smoke_checks" is null and "deployments"."rollback_evidence" is null and
        "deployments"."started_at" is null and "deployments"."completed_at" is null) or
      ("deployments"."status" = 'observed' and "deployments"."observed_by_actor_id" is not null and "deployments"."observed_at" is not null and
        jsonb_typeof("deployments"."observed_result") = 'object' and jsonb_typeof("deployments"."smoke_checks") = 'array' and
        jsonb_array_length("deployments"."smoke_checks") > 0 and jsonb_typeof("deployments"."rollback_evidence") = 'object' and
        "deployments"."started_at" is not null and "deployments"."completed_at" >= "deployments"."started_at")
    ));
