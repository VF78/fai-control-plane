CREATE TYPE "public"."runtime_availability_component" AS ENUM('service', 'scheduler', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."runtime_availability_state" AS ENUM('available', 'unavailable');--> statement-breakpoint
CREATE TABLE "runtime_availability_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runtime_registration_id" uuid NOT NULL,
	"component" "runtime_availability_component" NOT NULL,
	"state" "runtime_availability_state" NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"evidence_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_availability_observations_evidence_bounded" CHECK (length("runtime_availability_observations"."evidence_reference") between 1 and 500
        and "runtime_availability_observations"."evidence_reference" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "runtime_registrations" ADD COLUMN "service_max_age_seconds" integer;--> statement-breakpoint
ALTER TABLE "runtime_registrations" ADD COLUMN "scheduler_max_age_seconds" integer;--> statement-breakpoint
ALTER TABLE "runtime_registrations" ADD COLUMN "delivery_max_age_seconds" integer;--> statement-breakpoint
ALTER TABLE "runtime_availability_observations" ADD CONSTRAINT "runtime_availability_observations_runtime_registration_id_runtime_registrations_id_fk" FOREIGN KEY ("runtime_registration_id") REFERENCES "public"."runtime_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_availability_observations_fact_unique" ON "runtime_availability_observations" USING btree ("runtime_registration_id","component","observed_at");--> statement-breakpoint
CREATE INDEX "runtime_availability_observations_latest_idx" ON "runtime_availability_observations" USING btree ("runtime_registration_id","component","observed_at");--> statement-breakpoint
ALTER TABLE "runtime_registrations" ADD CONSTRAINT "runtime_registrations_service_max_age_bounded" CHECK ("runtime_registrations"."service_max_age_seconds" is null or "runtime_registrations"."service_max_age_seconds" between 30 and 604800);--> statement-breakpoint
ALTER TABLE "runtime_registrations" ADD CONSTRAINT "runtime_registrations_scheduler_max_age_bounded" CHECK ("runtime_registrations"."scheduler_max_age_seconds" is null or "runtime_registrations"."scheduler_max_age_seconds" between 30 and 604800);--> statement-breakpoint
ALTER TABLE "runtime_registrations" ADD CONSTRAINT "runtime_registrations_delivery_max_age_bounded" CHECK ("runtime_registrations"."delivery_max_age_seconds" is null or "runtime_registrations"."delivery_max_age_seconds" between 30 and 604800);