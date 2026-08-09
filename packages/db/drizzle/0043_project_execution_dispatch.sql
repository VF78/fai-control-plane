CREATE UNIQUE INDEX "runtime_registrations_identity_project_unique" ON "runtime_registrations" USING btree ("id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_packets_identity_project_unique" ON "task_packets" USING btree ("id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_identity_packet_unique" ON "agent_runs" USING btree ("id","task_packet_id");--> statement-breakpoint
CREATE TABLE "project_execution_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"execution_version" integer NOT NULL,
	"selection_hash" text NOT NULL,
	"task_packet_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"runtime_registration_id" uuid NOT NULL,
	"runtime_registration_version" integer NOT NULL,
	"requested_by_actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_execution_dispatches_execution_version_positive" CHECK ("project_execution_dispatches"."execution_version" > 0),
	CONSTRAINT "project_execution_dispatches_runtime_registration_version_positive" CHECK ("project_execution_dispatches"."runtime_registration_version" > 0),
	CONSTRAINT "project_execution_dispatches_selection_hash_sha256" CHECK ("project_execution_dispatches"."selection_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "project_execution_dispatches" ADD CONSTRAINT "project_execution_dispatches_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_execution_dispatches" ADD CONSTRAINT "project_execution_dispatches_execution_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project_executions"("project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_execution_dispatches" ADD CONSTRAINT "project_execution_dispatches_packet_project_fk" FOREIGN KEY ("task_packet_id","project_id") REFERENCES "public"."task_packets"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_execution_dispatches" ADD CONSTRAINT "project_execution_dispatches_run_packet_fk" FOREIGN KEY ("agent_run_id","task_packet_id") REFERENCES "public"."agent_runs"("id","task_packet_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_execution_dispatches" ADD CONSTRAINT "project_execution_dispatches_runtime_project_fk" FOREIGN KEY ("runtime_registration_id","project_id") REFERENCES "public"."runtime_registrations"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_execution_dispatches" ADD CONSTRAINT "project_execution_dispatches_workspace_requester_fk" FOREIGN KEY ("workspace_id","requested_by_actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_execution_dispatches_execution_unique" ON "project_execution_dispatches" USING btree ("project_id","execution_version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_execution_dispatches_packet_unique" ON "project_execution_dispatches" USING btree ("task_packet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_execution_dispatches_run_unique" ON "project_execution_dispatches" USING btree ("agent_run_id");
