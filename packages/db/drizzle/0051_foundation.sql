CREATE TABLE "project_acceptance_sessions" (
	"protocol_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_acceptance_sessions_version_positive" CHECK ("project_acceptance_sessions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "project_release_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"waived_by_actor_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_release_waivers_reason_bounded" CHECK (length("project_release_waivers"."reason") between 1 and 500 and btrim("project_release_waivers"."reason") <> '' and "project_release_waivers"."reason" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE TABLE "project_uat_protocols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"materialization_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"checklist" jsonb NOT NULL,
	"required_smoke_checks" text[] NOT NULL,
	"required_deployment_environment" text NOT NULL,
	"content_hash" text NOT NULL,
	"prepared_by_actor_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_uat_protocols_checklist_array" CHECK (jsonb_typeof("project_uat_protocols"."checklist") = 'array' and jsonb_array_length("project_uat_protocols"."checklist") > 0),
	CONSTRAINT "project_uat_protocols_smoke_nonempty" CHECK (cardinality("project_uat_protocols"."required_smoke_checks") between 1 and 50),
	CONSTRAINT "project_uat_protocols_release_environment" CHECK ("project_uat_protocols"."required_deployment_environment" in ('staging', 'production')),
	CONSTRAINT "project_uat_protocols_hash_sha256" CHECK ("project_uat_protocols"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "project_uat_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"outcome" text NOT NULL,
	"checks" jsonb NOT NULL,
	"recorded_by_actor_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_uat_results_sequence_positive" CHECK ("project_uat_results"."sequence" > 0),
	CONSTRAINT "project_uat_results_outcome_valid" CHECK ("project_uat_results"."outcome" in ('passed', 'failed')),
	CONSTRAINT "project_uat_results_checks_array" CHECK (jsonb_typeof("project_uat_results"."checks") = 'array' and jsonb_array_length("project_uat_results"."checks") > 0)
);
--> statement-breakpoint
CREATE TABLE "project_uat_signoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"evidence_reference" text NOT NULL,
	"command_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_uat_signoffs_kind_valid" CHECK ("project_uat_signoffs"."kind" in ('product_owner', 'client_representative')),
	CONSTRAINT "project_uat_signoffs_evidence_bounded" CHECK (length("project_uat_signoffs"."evidence_reference") between 1 and 2048 and btrim("project_uat_signoffs"."evidence_reference") <> '' and "project_uat_signoffs"."evidence_reference" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "project_acceptance_sessions" ADD CONSTRAINT "project_acceptance_sessions_protocol_id_project_uat_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."project_uat_protocols"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_acceptance_sessions" ADD CONSTRAINT "project_acceptance_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_release_waivers" ADD CONSTRAINT "project_release_waivers_protocol_id_project_uat_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."project_uat_protocols"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_release_waivers" ADD CONSTRAINT "project_release_waivers_waived_by_actor_id_actors_id_fk" FOREIGN KEY ("waived_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_uat_protocols" ADD CONSTRAINT "project_uat_protocols_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_uat_protocols" ADD CONSTRAINT "project_uat_protocols_plan_scope_fk" FOREIGN KEY ("plan_version_id","workspace_id","project_id") REFERENCES "public"."project_plan_versions"("id","workspace_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_uat_protocols" ADD CONSTRAINT "project_uat_protocols_materialization_scope_fk" FOREIGN KEY ("materialization_id","workspace_id","project_id","plan_version_id") REFERENCES "public"."project_plan_materializations"("id","workspace_id","project_id","plan_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_uat_protocols" ADD CONSTRAINT "project_uat_protocols_baseline_scope_fk" FOREIGN KEY ("baseline_id","project_id","plan_version_id") REFERENCES "public"."project_scope_baseline_versions"("id","project_id","source_plan_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_uat_protocols" ADD CONSTRAINT "project_uat_protocols_workspace_actor_fk" FOREIGN KEY ("workspace_id","prepared_by_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_uat_results" ADD CONSTRAINT "project_uat_results_protocol_id_project_uat_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."project_uat_protocols"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_uat_results" ADD CONSTRAINT "project_uat_results_recorded_by_actor_id_actors_id_fk" FOREIGN KEY ("recorded_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_uat_signoffs" ADD CONSTRAINT "project_uat_signoffs_protocol_id_project_uat_protocols_id_fk" FOREIGN KEY ("protocol_id") REFERENCES "public"."project_uat_protocols"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_uat_signoffs" ADD CONSTRAINT "project_uat_signoffs_result_id_project_uat_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."project_uat_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_uat_signoffs" ADD CONSTRAINT "project_uat_signoffs_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_acceptance_sessions_project_unique" ON "project_acceptance_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_release_waivers_protocol_unique" ON "project_release_waivers" USING btree ("protocol_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_release_waivers_command_unique" ON "project_release_waivers" USING btree ("command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_uat_protocols_project_unique" ON "project_uat_protocols" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_uat_protocols_command_unique" ON "project_uat_protocols" USING btree ("command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_uat_results_protocol_sequence_unique" ON "project_uat_results" USING btree ("protocol_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "project_uat_results_command_unique" ON "project_uat_results" USING btree ("command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_uat_signoffs_result_kind_unique" ON "project_uat_signoffs" USING btree ("result_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "project_uat_signoffs_command_unique" ON "project_uat_signoffs" USING btree ("command_id");--> statement-breakpoint
CREATE TRIGGER "project_uat_protocols_reject_update_delete"
BEFORE UPDATE OR DELETE ON "project_uat_protocols"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_immutable_row_change_0002"();--> statement-breakpoint
CREATE TRIGGER "project_uat_results_reject_update_delete"
BEFORE UPDATE OR DELETE ON "project_uat_results"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_immutable_row_change_0002"();--> statement-breakpoint
CREATE TRIGGER "project_uat_signoffs_reject_update_delete"
BEFORE UPDATE OR DELETE ON "project_uat_signoffs"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_immutable_row_change_0002"();--> statement-breakpoint
CREATE TRIGGER "project_release_waivers_reject_update_delete"
BEFORE UPDATE OR DELETE ON "project_release_waivers"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_immutable_row_change_0002"();
