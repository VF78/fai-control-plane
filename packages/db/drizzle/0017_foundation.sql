CREATE TYPE "public"."tracker_status_observation_state" AS ENUM('pending', 'processing', 'applied', 'acknowledged', 'conflict');--> statement-breakpoint
CREATE TABLE "tracker_status_observation_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_operation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"mapped_status" "work_item_status" NOT NULL,
	"expected_canonical_version" integer NOT NULL,
	"binding_inbound_version" text NOT NULL,
	"outbound_mutation_id" uuid,
	"state" "tracker_status_observation_state" DEFAULT 'pending' NOT NULL,
	"conflict_code" text,
	"processing_token" uuid,
	"processing_lease_expires_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_status_observation_expected_version_positive" CHECK ("tracker_status_observation_inbox"."expected_canonical_version" > 0),
	CONSTRAINT "tracker_status_observation_processing_claim_valid" CHECK ((
        "tracker_status_observation_inbox"."state" = 'processing'
        and "tracker_status_observation_inbox"."processing_token" is not null
        and "tracker_status_observation_inbox"."processing_lease_expires_at" is not null
      ) or (
        "tracker_status_observation_inbox"."state" <> 'processing'
        and "tracker_status_observation_inbox"."processing_token" is null
        and "tracker_status_observation_inbox"."processing_lease_expires_at" is null
      )),
	CONSTRAINT "tracker_status_observation_conflict_code_valid" CHECK (("tracker_status_observation_inbox"."state" = 'conflict' and "tracker_status_observation_inbox"."conflict_code" is not null)
        or ("tracker_status_observation_inbox"."state" <> 'conflict' and "tracker_status_observation_inbox"."conflict_code" is null))
);
--> statement-breakpoint
ALTER TABLE "tracker_status_observation_inbox" ADD CONSTRAINT "tracker_status_observation_inbox_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_status_observation_inbox" ADD CONSTRAINT "tracker_status_observation_inbox_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_status_observation_inbox" ADD CONSTRAINT "tracker_status_observation_inbox_binding_id_tracker_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."tracker_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_status_observation_inbox" ADD CONSTRAINT "tracker_status_observation_inbox_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_status_observation_inbox" ADD CONSTRAINT "tracker_status_observation_inbox_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_status_observation_binding_snapshot_unique" ON "tracker_status_observation_inbox" USING btree ("binding_id","snapshot_operation_id");--> statement-breakpoint
CREATE INDEX "tracker_status_observation_claim_idx" ON "tracker_status_observation_inbox" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "tracker_status_observation_work_item_idx" ON "tracker_status_observation_inbox" USING btree ("work_item_id","created_at");