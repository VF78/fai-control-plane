CREATE TYPE "public"."risk_signal_disposition_kind" AS ENUM('acknowledged', 'snoozed');--> statement-breakpoint
CREATE TABLE "risk_signal_disposition_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"risk_signal_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"kind" "risk_signal_disposition_kind" NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reentry_condition" text NOT NULL,
	"version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_signal_disposition_events_reason_bounded" CHECK ("risk_signal_disposition_events"."reason" in ('investigating', 'awaiting_evidence', 'planned_maintenance', 'external_dependency')),
	CONSTRAINT "risk_signal_disposition_events_expiry_after_occurrence" CHECK ("risk_signal_disposition_events"."expires_at" > "risk_signal_disposition_events"."occurred_at"),
	CONSTRAINT "risk_signal_disposition_events_reentry_condition" CHECK ("risk_signal_disposition_events"."reentry_condition" = 'risk_unresolved_at_expiry'),
	CONSTRAINT "risk_signal_disposition_events_version_positive" CHECK ("risk_signal_disposition_events"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "risk_signal_disposition_events" ADD CONSTRAINT "risk_signal_disposition_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_signal_disposition_events" ADD CONSTRAINT "risk_signal_disposition_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_signal_disposition_events" ADD CONSTRAINT "risk_signal_disposition_events_risk_signal_id_risk_signals_id_fk" FOREIGN KEY ("risk_signal_id") REFERENCES "public"."risk_signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_signal_disposition_events" ADD CONSTRAINT "risk_signal_disposition_events_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_signal_disposition_events_workspace_command_unique" ON "risk_signal_disposition_events" USING btree ("workspace_id","command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_signal_disposition_events_signal_version_unique" ON "risk_signal_disposition_events" USING btree ("risk_signal_id","version");--> statement-breakpoint
CREATE INDEX "risk_signal_disposition_events_project_signal_idx" ON "risk_signal_disposition_events" USING btree ("project_id","risk_signal_id","version");