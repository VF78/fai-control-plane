ALTER TABLE "incoming_events" ALTER COLUMN "verification" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "incoming_events" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "incoming_events" ADD COLUMN "installation_id" text;--> statement-breakpoint
ALTER TABLE "incoming_events" ADD COLUMN "repository_id" text;--> statement-breakpoint
ALTER TABLE "incoming_events" ADD COLUMN "project_node_id" text;--> statement-breakpoint
ALTER TABLE "incoming_events" ADD COLUMN "payload_sha256" text;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "incoming_events") THEN
    DROP INDEX "incoming_events_delivery_unique";

    UPDATE "incoming_events"
    SET "provider" = 'legacy-' || "provider";

    CREATE UNIQUE INDEX "incoming_events_delivery_unique"
      ON "incoming_events" USING btree ("provider", "delivery_id");
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "incoming_events" ADD CONSTRAINT "incoming_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incoming_events_project_received_idx" ON "incoming_events" USING btree ("project_id","received_at");--> statement-breakpoint
ALTER TABLE "incoming_events" ADD CONSTRAINT "incoming_events_payload_sha256_valid" CHECK (
  (
    "incoming_events"."provider" LIKE 'legacy-%'
    and "incoming_events"."project_id" is null
    and "incoming_events"."payload_sha256" is null
  )
  or
  (
    "incoming_events"."provider" NOT LIKE 'legacy-%'
    and "incoming_events"."project_id" is not null
    and coalesce("incoming_events"."payload_sha256" ~ '^[0-9a-f]{64}$', false)
  )
);--> statement-breakpoint
ALTER TABLE "incoming_events" ADD CONSTRAINT "incoming_events_github_verified_source" CHECK ("incoming_events"."provider" <> 'github' or (
  "incoming_events"."verification" = '{"outcome":"verified","method":"hmac-sha256"}'::jsonb
  and "incoming_events"."installation_id" ~ '^[1-9][0-9]{0,19}$'
  and "incoming_events"."repository_id" ~ '^[1-9][0-9]{0,19}$'
  and "incoming_events"."project_node_id" is not null
  and length("incoming_events"."project_node_id") between 1 and 128
));
