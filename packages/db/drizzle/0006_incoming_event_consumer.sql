ALTER TABLE "incoming_events" ADD COLUMN "processing_token" uuid;--> statement-breakpoint
ALTER TABLE "incoming_events" ADD COLUMN "processing_lease_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "incoming_events"
SET "status" = 'pending'
WHERE "status" = 'processing';--> statement-breakpoint
ALTER TABLE "incoming_events" ADD CONSTRAINT "incoming_events_processing_claim_valid" CHECK (
  (
    "status" = 'processing'
    and "processing_token" is not null
    and "processing_lease_expires_at" is not null
  ) or (
    "status" <> 'processing'
    and "processing_token" is null
    and "processing_lease_expires_at" is null
  )
);--> statement-breakpoint
CREATE INDEX "incoming_events_processing_lease_idx"
  ON "incoming_events" USING btree ("status", "processing_lease_expires_at")
  WHERE "incoming_events"."status" = 'processing';--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_events_incoming_event_unique"
  ON "canonical_events" USING btree ("incoming_event_id")
  WHERE "canonical_events"."incoming_event_id" is not null;
