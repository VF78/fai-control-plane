CREATE TYPE "public"."notification_audience_kind" AS ENUM('actor', 'project_operators');--> statement-breakpoint
CREATE TYPE "public"."notification_delivery_status" AS ENUM('accepted', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "notification_delivery_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"notification_intent_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"status" "notification_delivery_status" NOT NULL,
	"failure_code" text,
	"version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_delivery_receipts_failure_shape" CHECK (("notification_delivery_receipts"."status" = 'failed' and "notification_delivery_receipts"."failure_code" ~ '^[a-z][a-z0-9_]{0,63}$')
        or ("notification_delivery_receipts"."status" <> 'failed' and "notification_delivery_receipts"."failure_code" is null)),
	CONSTRAINT "notification_delivery_receipts_version_positive" CHECK ("notification_delivery_receipts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "notification_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"risk_signal_id" uuid NOT NULL,
	"audience_kind" "notification_audience_kind" NOT NULL,
	"audience_actor_id" uuid,
	"category" text NOT NULL,
	"severity" "risk_severity" NOT NULL,
	"summary" text NOT NULL,
	"next_action" text NOT NULL,
	"evidence_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deduplication_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_intents_audience_shape" CHECK (("notification_intents"."audience_kind" = 'actor' and "notification_intents"."audience_actor_id" is not null)
        or ("notification_intents"."audience_kind" = 'project_operators' and "notification_intents"."audience_actor_id" is null)),
	CONSTRAINT "notification_intents_category_key" CHECK ("notification_intents"."category" ~ '^[a-z][a-z0-9_]{0,127}$'),
	CONSTRAINT "notification_intents_dedup_key_bounded" CHECK (length("notification_intents"."deduplication_key") between 1 and 200),
	CONSTRAINT "notification_intents_actionable" CHECK (length(btrim("notification_intents"."summary")) between 1 and 500
        and length(btrim("notification_intents"."next_action")) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "notification_delivery_receipts" ADD CONSTRAINT "notification_delivery_receipts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_receipts" ADD CONSTRAINT "notification_delivery_receipts_notification_intent_id_notification_intents_id_fk" FOREIGN KEY ("notification_intent_id") REFERENCES "public"."notification_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_risk_signal_id_risk_signals_id_fk" FOREIGN KEY ("risk_signal_id") REFERENCES "public"."risk_signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_audience_actor_id_actors_id_fk" FOREIGN KEY ("audience_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_receipts_project_command_unique" ON "notification_delivery_receipts" USING btree ("project_id","command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_receipts_intent_version_unique" ON "notification_delivery_receipts" USING btree ("notification_intent_id","version");--> statement-breakpoint
CREATE INDEX "notification_delivery_receipts_project_intent_idx" ON "notification_delivery_receipts" USING btree ("project_id","notification_intent_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_intents_risk_signal_unique" ON "notification_intents" USING btree ("risk_signal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_intents_project_dedup_unique" ON "notification_intents" USING btree ("project_id","deduplication_key");--> statement-breakpoint
CREATE INDEX "notification_intents_project_created_idx" ON "notification_intents" USING btree ("project_id","created_at");