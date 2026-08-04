CREATE TABLE "project_scope_baseline_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"accepted_weight" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"evidence_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_scope_baseline_observations_accepted_nonnegative" CHECK ("project_scope_baseline_observations"."accepted_weight" >= 0),
	CONSTRAINT "project_scope_baseline_observations_evidence_bounded" CHECK (length("project_scope_baseline_observations"."evidence_reference") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "project_scope_baselines" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"total_weight" integer NOT NULL,
	"accepted_weight" integer DEFAULT 0 NOT NULL,
	"review_weight" integer DEFAULT 0 NOT NULL,
	"in_progress_weight" integer DEFAULT 0 NOT NULL,
	"not_started_weight" integer DEFAULT 0 NOT NULL,
	"checkpoint_title" text,
	"checkpoint_status" "work_item_status",
	"checkpoint_owner_actor_id" uuid,
	"checkpoint_target_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_scope_baselines_total_weight_positive" CHECK ("project_scope_baselines"."total_weight" > 0),
	CONSTRAINT "project_scope_baselines_outcomes_nonnegative" CHECK ("project_scope_baselines"."accepted_weight" >= 0 AND "project_scope_baselines"."review_weight" >= 0 AND "project_scope_baselines"."in_progress_weight" >= 0 AND "project_scope_baselines"."not_started_weight" >= 0),
	CONSTRAINT "project_scope_baselines_outcomes_match_total" CHECK ("project_scope_baselines"."accepted_weight" + "project_scope_baselines"."review_weight" + "project_scope_baselines"."in_progress_weight" + "project_scope_baselines"."not_started_weight" = "project_scope_baselines"."total_weight"),
	CONSTRAINT "project_scope_baselines_checkpoint_complete" CHECK (("project_scope_baselines"."checkpoint_title" IS NULL AND "project_scope_baselines"."checkpoint_status" IS NULL AND "project_scope_baselines"."checkpoint_owner_actor_id" IS NULL AND "project_scope_baselines"."checkpoint_target_at" IS NULL) OR ("project_scope_baselines"."checkpoint_title" IS NOT NULL AND "project_scope_baselines"."checkpoint_status" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "project_scope_baseline_observations" ADD CONSTRAINT "project_scope_baseline_observations_project_id_project_scope_baselines_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project_scope_baselines"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_baselines" ADD CONSTRAINT "project_scope_baselines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_baselines" ADD CONSTRAINT "project_scope_baselines_checkpoint_owner_actor_id_actors_id_fk" FOREIGN KEY ("checkpoint_owner_actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_baseline_observations_project_observed_unique" ON "project_scope_baseline_observations" USING btree ("project_id","observed_at");--> statement-breakpoint
CREATE INDEX "project_scope_baseline_observations_project_observed_idx" ON "project_scope_baseline_observations" USING btree ("project_id","observed_at");