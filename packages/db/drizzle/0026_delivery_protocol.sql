ALTER TABLE "runbooks" ADD COLUMN "protocol_state" text;--> statement-breakpoint
ALTER TABLE "runbooks" ADD COLUMN "revision" integer;--> statement-breakpoint
ALTER TABLE "runbooks" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "runbooks_one_active_delivery_protocol_per_project" ON "runbooks" USING btree ("project_id") WHERE "runbooks"."protocol_state" = 'published' AND "runbooks"."active";--> statement-breakpoint
ALTER TABLE "runbooks" ADD CONSTRAINT "runbooks_delivery_protocol_metadata_complete" CHECK (("runbooks"."protocol_state" IS NULL AND "runbooks"."revision" IS NULL AND "runbooks"."content_hash" IS NULL) OR
          ("runbooks"."protocol_state" IN ('draft', 'published', 'retired') AND
           "runbooks"."revision" > 0 AND "runbooks"."content_hash" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "runbooks" ADD CONSTRAINT "runbooks_delivery_protocol_active_state" CHECK ("runbooks"."protocol_state" IS NULL OR "runbooks"."protocol_state" = 'published' OR NOT "runbooks"."active");