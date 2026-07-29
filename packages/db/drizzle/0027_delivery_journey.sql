CREATE TABLE "delivery_journey_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_item_id" uuid NOT NULL,
	"stage_key" text NOT NULL,
	"requirement" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_journey_evidence_reference_nonempty" CHECK (length("delivery_journey_evidence"."evidence_reference") BETWEEN 1 AND 2048)
);
--> statement-breakpoint
CREATE TABLE "delivery_journeys" (
	"work_item_id" uuid PRIMARY KEY NOT NULL,
	"protocol_id" uuid NOT NULL,
	"protocol_version" integer NOT NULL,
	"stage_key" text NOT NULL,
	"deadline_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_journeys_stage_key_valid" CHECK ("delivery_journeys"."stage_key" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "delivery_journeys_protocol_version_positive" CHECK ("delivery_journeys"."protocol_version" > 0),
	CONSTRAINT "delivery_journeys_version_positive" CHECK ("delivery_journeys"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "delivery_journey_evidence" ADD CONSTRAINT "delivery_journey_evidence_work_item_id_delivery_journeys_work_item_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."delivery_journeys"("work_item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_journeys" ADD CONSTRAINT "delivery_journeys_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runbooks_id_version_unique" ON "runbooks" USING btree ("id","version");--> statement-breakpoint
ALTER TABLE "delivery_journeys" ADD CONSTRAINT "delivery_journeys_protocol_version_fk" FOREIGN KEY ("protocol_id","protocol_version") REFERENCES "public"."runbooks"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_journey_evidence_stage_requirement_unique" ON "delivery_journey_evidence" USING btree ("work_item_id","stage_key","requirement");--> statement-breakpoint
CREATE INDEX "delivery_journey_evidence_work_item_idx" ON "delivery_journey_evidence" USING btree ("work_item_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_journeys_protocol_version_idx" ON "delivery_journeys" USING btree ("protocol_id","protocol_version");
