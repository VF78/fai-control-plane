CREATE TYPE "public"."scope_outcome_state" AS ENUM('accepted', 'review', 'in_progress', 'not_started', 'not_configured');--> statement-breakpoint
CREATE TABLE "project_scope_baseline_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"approved_by_actor_id" uuid,
	"approved_at" timestamp with time zone,
	"checkpoint_title" text,
	"checkpoint_status" "work_item_status",
	"checkpoint_owner_actor_id" uuid,
	"checkpoint_target_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_scope_baseline_versions_version_positive" CHECK ("project_scope_baseline_versions"."version" > 0),
	CONSTRAINT "project_scope_baseline_versions_checkpoint_complete" CHECK (("project_scope_baseline_versions"."checkpoint_title" IS NULL AND "project_scope_baseline_versions"."checkpoint_status" IS NULL AND "project_scope_baseline_versions"."checkpoint_owner_actor_id" IS NULL AND "project_scope_baseline_versions"."checkpoint_target_at" IS NULL) OR ("project_scope_baseline_versions"."checkpoint_title" IS NOT NULL AND "project_scope_baseline_versions"."checkpoint_status" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "project_scope_outcome_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"accepted_weight" integer NOT NULL,
	"total_weight" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"evidence_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_scope_outcome_observations_weights_valid" CHECK ("project_scope_outcome_observations"."accepted_weight" >= 0 AND "project_scope_outcome_observations"."total_weight" > 0 AND "project_scope_outcome_observations"."accepted_weight" <= "project_scope_outcome_observations"."total_weight"),
	CONSTRAINT "project_scope_outcome_observations_evidence_bounded" CHECK (length("project_scope_outcome_observations"."evidence_reference") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "project_scope_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"baseline_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"weight" integer NOT NULL,
	"state" "scope_outcome_state" NOT NULL,
	"accepted_by_actor_id" uuid,
	"accepted_at" timestamp with time zone,
	"evidence_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_scope_outcomes_weight_positive" CHECK ("project_scope_outcomes"."weight" > 0)
);
--> statement-breakpoint
ALTER TABLE "project_scope_baseline_versions" ADD CONSTRAINT "project_scope_baseline_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_baseline_versions" ADD CONSTRAINT "project_scope_baseline_versions_approved_by_actor_id_actors_id_fk" FOREIGN KEY ("approved_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_baseline_versions" ADD CONSTRAINT "project_scope_baseline_versions_checkpoint_owner_actor_id_actors_id_fk" FOREIGN KEY ("checkpoint_owner_actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_outcome_observations" ADD CONSTRAINT "project_scope_outcome_observations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_outcome_observations" ADD CONSTRAINT "project_scope_outcome_observations_baseline_id_project_scope_baseline_versions_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."project_scope_baseline_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_outcomes" ADD CONSTRAINT "project_scope_outcomes_baseline_id_project_scope_baseline_versions_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."project_scope_baseline_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_outcomes" ADD CONSTRAINT "project_scope_outcomes_accepted_by_actor_id_actors_id_fk" FOREIGN KEY ("accepted_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_baseline_versions_project_version_unique" ON "project_scope_baseline_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_baseline_versions_one_active_per_project" ON "project_scope_baseline_versions" USING btree ("project_id") WHERE "project_scope_baseline_versions"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_outcome_observations_project_observed_unique" ON "project_scope_outcome_observations" USING btree ("project_id","observed_at");--> statement-breakpoint
CREATE INDEX "project_scope_outcome_observations_project_observed_idx" ON "project_scope_outcome_observations" USING btree ("project_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_outcomes_baseline_key_unique" ON "project_scope_outcomes" USING btree ("baseline_id","key");