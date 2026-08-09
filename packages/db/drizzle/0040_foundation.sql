CREATE TABLE "project_plan_materializations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"plan_version" integer NOT NULL,
	"plan_hash" text NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"outcome_count" integer NOT NULL,
	"milestone_count" integer NOT NULL,
	"work_item_count" integer NOT NULL,
	"dependency_count" integer NOT NULL,
	"journey_count" integer NOT NULL,
	"publication_intent_count" integer NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_plan_materializations_hashes_valid" CHECK ("project_plan_materializations"."plan_hash" ~ '^[0-9a-f]{64}$' and "project_plan_materializations"."source_manifest_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_plan_materializations_plan_version_positive" CHECK ("project_plan_materializations"."plan_version" > 0),
	CONSTRAINT "project_plan_materializations_counts_nonnegative" CHECK ("project_plan_materializations"."outcome_count" > 0 and "project_plan_materializations"."milestone_count" > 0 and "project_plan_materializations"."work_item_count" > 0 and "project_plan_materializations"."dependency_count" >= 0 and "project_plan_materializations"."journey_count" >= 0 and "project_plan_materializations"."publication_intent_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_publication_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"mode" text NOT NULL,
	"resource_kind" text NOT NULL,
	"canonical_id" uuid NOT NULL,
	"state" text DEFAULT 'desired' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_publication_intents_surface" CHECK ("project_publication_intents"."surface" in ('repository', 'tracker')),
	CONSTRAINT "project_publication_intents_mode" CHECK ("project_publication_intents"."mode" in ('link_existing', 'create_managed')),
	CONSTRAINT "project_publication_intents_resource_kind" CHECK ("project_publication_intents"."resource_kind" in ('baseline', 'outcome', 'milestone', 'work_item')),
	CONSTRAINT "project_publication_intents_state" CHECK ("project_publication_intents"."state" = 'desired')
);
--> statement-breakpoint
CREATE TABLE "work_item_dependencies" (
	"work_item_id" uuid NOT NULL,
	"depends_on_work_item_id" uuid NOT NULL,
	"source_plan_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_item_dependencies_pk" PRIMARY KEY("work_item_id","depends_on_work_item_id"),
	CONSTRAINT "work_item_dependencies_not_self" CHECK ("work_item_dependencies"."work_item_id" <> "work_item_dependencies"."depends_on_work_item_id")
);
--> statement-breakpoint
CREATE TABLE "work_item_scope_outcomes" (
	"work_item_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"source_plan_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_item_scope_outcomes_pk" PRIMARY KEY("work_item_id","outcome_id")
);
--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "source_plan_version_id" uuid;--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "checkpoint" text;--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "source_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "project_scope_baseline_versions" ADD COLUMN "source_plan_version_id" uuid;--> statement-breakpoint
ALTER TABLE "project_scope_baseline_versions" ADD COLUMN "source_plan_hash" text;--> statement-breakpoint
ALTER TABLE "project_scope_outcomes" ADD COLUMN "source_plan_version_id" uuid;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "source_plan_version_id" uuid;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "source_task_key" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "acceptance_evidence" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_versions_identity_scope_version_unique" ON "project_plan_versions" USING btree ("id","workspace_id","project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_versions_identity_scope_unique" ON "project_plan_versions" USING btree ("id","workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_versions_project_identity_unique" ON "project_plan_versions" USING btree ("project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_versions_identity_project_unique" ON "project_plan_versions" USING btree ("id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_baseline_versions_identity_project_source_unique" ON "project_scope_baseline_versions" USING btree ("id","project_id","source_plan_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_baseline_versions_identity_source_unique" ON "project_scope_baseline_versions" USING btree ("id","source_plan_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_outcomes_identity_source_plan_unique" ON "project_scope_outcomes" USING btree ("id","source_plan_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_identity_source_plan_unique" ON "work_items" USING btree ("id","source_plan_version_id");--> statement-breakpoint
ALTER TABLE "project_plan_materializations" ADD CONSTRAINT "project_plan_materializations_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_materializations" ADD CONSTRAINT "project_plan_materializations_plan_scope_fk" FOREIGN KEY ("plan_version_id","workspace_id","project_id","plan_version") REFERENCES "public"."project_plan_versions"("id","workspace_id","project_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_materializations" ADD CONSTRAINT "project_plan_materializations_baseline_scope_fk" FOREIGN KEY ("baseline_id","project_id","plan_version_id") REFERENCES "public"."project_scope_baseline_versions"("id","project_id","source_plan_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_materializations" ADD CONSTRAINT "project_plan_materializations_workspace_actor_fk" FOREIGN KEY ("workspace_id","created_by_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_publication_intents" ADD CONSTRAINT "project_publication_intents_plan_scope_fk" FOREIGN KEY ("plan_version_id","workspace_id","project_id") REFERENCES "public"."project_plan_versions"("id","workspace_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_dependencies" ADD CONSTRAINT "work_item_dependencies_item_plan_fk" FOREIGN KEY ("work_item_id","source_plan_version_id") REFERENCES "public"."work_items"("id","source_plan_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_dependencies" ADD CONSTRAINT "work_item_dependencies_dependency_plan_fk" FOREIGN KEY ("depends_on_work_item_id","source_plan_version_id") REFERENCES "public"."work_items"("id","source_plan_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_scope_outcomes" ADD CONSTRAINT "work_item_scope_outcomes_item_plan_fk" FOREIGN KEY ("work_item_id","source_plan_version_id") REFERENCES "public"."work_items"("id","source_plan_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_scope_outcomes" ADD CONSTRAINT "work_item_scope_outcomes_outcome_plan_fk" FOREIGN KEY ("outcome_id","source_plan_version_id") REFERENCES "public"."project_scope_outcomes"("id","source_plan_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_materializations_plan_version_unique" ON "project_plan_materializations" USING btree ("plan_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_materializations_baseline_unique" ON "project_plan_materializations" USING btree ("baseline_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_plan_materializations_command_unique" ON "project_plan_materializations" USING btree ("command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_publication_intents_idempotency_unique" ON "project_publication_intents" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "project_publication_intents_project_state_idx" ON "project_publication_intents" USING btree ("project_id","state");--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_plan_version_fk" FOREIGN KEY ("project_id","source_plan_version_id") REFERENCES "public"."project_plan_versions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_baseline_versions" ADD CONSTRAINT "project_scope_baseline_versions_project_plan_fk" FOREIGN KEY ("project_id","source_plan_version_id") REFERENCES "public"."project_plan_versions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_outcomes" ADD CONSTRAINT "project_scope_outcomes_baseline_plan_fk" FOREIGN KEY ("baseline_id","source_plan_version_id") REFERENCES "public"."project_scope_baseline_versions"("id","source_plan_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_plan_version_fk" FOREIGN KEY ("project_id","source_plan_version_id") REFERENCES "public"."project_plan_versions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_plan_source_key_unique" ON "milestones" USING btree ("source_plan_version_id","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_baseline_versions_source_plan_unique" ON "project_scope_baseline_versions" USING btree ("source_plan_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_plan_source_key_unique" ON "work_items" USING btree ("source_plan_version_id","source_task_key");--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_plan_source_complete" CHECK (("milestones"."source_plan_version_id" is null and "milestones"."source_key" is null and "milestones"."checkpoint" is null and "milestones"."source_evidence" is null) or ("milestones"."source_plan_version_id" is not null and "milestones"."source_key" is not null and "milestones"."checkpoint" is not null and "milestones"."source_evidence" is not null));--> statement-breakpoint
ALTER TABLE "project_scope_baseline_versions" ADD CONSTRAINT "project_scope_baseline_versions_source_complete" CHECK (("project_scope_baseline_versions"."source_plan_version_id" is null and "project_scope_baseline_versions"."source_plan_hash" is null) or ("project_scope_baseline_versions"."source_plan_version_id" is not null and "project_scope_baseline_versions"."source_plan_hash" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_plan_source_complete" CHECK (("work_items"."source_plan_version_id" is null and "work_items"."source_task_key" is null and "work_items"."acceptance_evidence" is null) or ("work_items"."source_plan_version_id" is not null and "work_items"."source_task_key" is not null and "work_items"."acceptance_evidence" is not null));
