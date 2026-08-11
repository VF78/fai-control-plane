CREATE TABLE "qa_review_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_packet_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"checks" jsonb NOT NULL,
	"artifacts" jsonb NOT NULL,
	"failures" jsonb NOT NULL,
	"risks" jsonb NOT NULL,
	"evidence_references" jsonb NOT NULL,
	"recorded_by_actor_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_review_receipts_outcome_valid" CHECK ("qa_review_receipts"."outcome" in ('passed', 'failed')),
	CONSTRAINT "qa_review_receipts_checks_array" CHECK (jsonb_typeof("qa_review_receipts"."checks") = 'array'),
	CONSTRAINT "qa_review_receipts_artifacts_array" CHECK (jsonb_typeof("qa_review_receipts"."artifacts") = 'array'),
	CONSTRAINT "qa_review_receipts_failures_array" CHECK (jsonb_typeof("qa_review_receipts"."failures") = 'array'),
	CONSTRAINT "qa_review_receipts_risks_array" CHECK (jsonb_typeof("qa_review_receipts"."risks") = 'array'),
	CONSTRAINT "qa_review_receipts_evidence_array" CHECK (jsonb_typeof("qa_review_receipts"."evidence_references") = 'array')
);
--> statement-breakpoint
CREATE TABLE "qa_task_packets" (
	"task_packet_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"work_item_version" integer NOT NULL,
	"protocol_id" uuid NOT NULL,
	"protocol_version" integer NOT NULL,
	"journey_version" integer NOT NULL,
	"stage_key" text NOT NULL,
	"responsibility" jsonb NOT NULL,
	"required_evidence" text[] NOT NULL,
	"prepared_by_actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_task_packets_work_item_version_positive" CHECK ("qa_task_packets"."work_item_version" > 0),
	CONSTRAINT "qa_task_packets_protocol_version_positive" CHECK ("qa_task_packets"."protocol_version" > 0),
	CONSTRAINT "qa_task_packets_journey_version_positive" CHECK ("qa_task_packets"."journey_version" > 0),
	CONSTRAINT "qa_task_packets_stage_key_valid" CHECK ("qa_task_packets"."stage_key" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "qa_task_packets_responsibility_object" CHECK (jsonb_typeof("qa_task_packets"."responsibility") = 'object')
);
--> statement-breakpoint
ALTER TABLE "qa_review_receipts" ADD CONSTRAINT "qa_review_receipts_task_packet_id_qa_task_packets_task_packet_id_fk" FOREIGN KEY ("task_packet_id") REFERENCES "public"."qa_task_packets"("task_packet_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_review_receipts" ADD CONSTRAINT "qa_review_receipts_recorded_by_actor_id_actors_id_fk" FOREIGN KEY ("recorded_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_task_packets" ADD CONSTRAINT "qa_task_packets_task_packet_id_task_packets_id_fk" FOREIGN KEY ("task_packet_id") REFERENCES "public"."task_packets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_task_packets" ADD CONSTRAINT "qa_task_packets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_task_packets" ADD CONSTRAINT "qa_task_packets_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_task_packets" ADD CONSTRAINT "qa_task_packets_prepared_by_actor_id_actors_id_fk" FOREIGN KEY ("prepared_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_task_packets" ADD CONSTRAINT "qa_task_packets_project_plan_version_fk" FOREIGN KEY ("project_id","plan_version_id") REFERENCES "public"."project_plan_versions"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_task_packets" ADD CONSTRAINT "qa_task_packets_protocol_version_fk" FOREIGN KEY ("protocol_id","protocol_version") REFERENCES "public"."runbooks"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qa_review_receipts_packet_unique" ON "qa_review_receipts" USING btree ("task_packet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_review_receipts_command_unique" ON "qa_review_receipts" USING btree ("command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_task_packets_work_item_journey_stage_unique" ON "qa_task_packets" USING btree ("work_item_id","work_item_version","journey_version","stage_key");