CREATE TABLE "runtime_recovery_policies" (
	"runtime_registration_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"stale_threshold_seconds" integer NOT NULL,
	"maximum_attempts" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_recovery_policies_stale_threshold_bounded" CHECK ("runtime_recovery_policies"."stale_threshold_seconds" between 30 and 604800),
	CONSTRAINT "runtime_recovery_policies_maximum_attempts_bounded" CHECK ("runtime_recovery_policies"."maximum_attempts" between 1 and 10),
	CONSTRAINT "runtime_recovery_policies_version_positive" CHECK ("runtime_recovery_policies"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "runtime_availability_observations" ADD COLUMN "ttl_seconds" integer;--> statement-breakpoint
ALTER TABLE "runtime_recovery_policies" ADD CONSTRAINT "runtime_recovery_policies_runtime_registration_id_runtime_registrations_id_fk" FOREIGN KEY ("runtime_registration_id") REFERENCES "public"."runtime_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_availability_observations" ADD CONSTRAINT "runtime_availability_observations_ttl_bounded" CHECK ("runtime_availability_observations"."ttl_seconds" between 30 and 604800);
