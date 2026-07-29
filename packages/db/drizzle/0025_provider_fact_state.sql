ALTER TABLE "build_checks" ADD COLUMN "external_version" text;--> statement-breakpoint
ALTER TABLE "build_checks" ADD COLUMN "observed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "build_checks" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "build_checks" ADD COLUMN "evidence_state" text DEFAULT 'observed' NOT NULL;--> statement-breakpoint
ALTER TABLE "build_checks" ADD COLUMN "conflict_reason" text;--> statement-breakpoint
ALTER TABLE "pr_links" ADD COLUMN "external_version" text;--> statement-breakpoint
ALTER TABLE "pr_links" ADD COLUMN "observed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_links" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pr_links" ADD COLUMN "evidence_state" text DEFAULT 'observed' NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_links" ADD COLUMN "conflict_reason" text;--> statement-breakpoint
ALTER TABLE "tracker_bindings" ADD COLUMN "observed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tracker_bindings" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracker_bindings" ADD COLUMN "evidence_state" text DEFAULT 'observed' NOT NULL;--> statement-breakpoint
ALTER TABLE "tracker_bindings" ADD COLUMN "conflict_reason" text;--> statement-breakpoint
UPDATE "tracker_bindings"
SET "observed_at" = "updated_at";--> statement-breakpoint
UPDATE "pr_links" AS "pr"
SET
  "external_version" = "binding"."external_version",
  "observed_at" = "binding"."observed_at"
FROM "tracker_bindings" AS "binding"
WHERE
  "binding"."surface" = 'pull_request'
  AND "binding"."entity_type" = 'pr_link'
  AND "binding"."entity_id" = "pr"."id"
  AND "binding"."provider" = "pr"."provider"
  AND "binding"."external_id" = "pr"."external_id";--> statement-breakpoint
UPDATE "build_checks" AS "check"
SET
  "external_version" = "binding"."external_version",
  "observed_at" = "binding"."observed_at"
FROM "tracker_bindings" AS "binding"
WHERE
  "binding"."surface" = 'check'
  AND "binding"."entity_type" = 'build_check'
  AND "binding"."entity_id" = "check"."id"
  AND "binding"."provider" = "check"."provider"
  AND "binding"."external_id" = "check"."external_id";--> statement-breakpoint
ALTER TABLE "build_checks" ADD CONSTRAINT "build_checks_evidence_state_valid" CHECK ("build_checks"."evidence_state" in (
        'observed', 'pending_confirmation', 'confirmed', 'stale', 'conflict', 'missing'
      ));--> statement-breakpoint
ALTER TABLE "build_checks" ADD CONSTRAINT "build_checks_conflict_reason_valid" CHECK (("build_checks"."evidence_state" = 'conflict'
        and "build_checks"."conflict_reason" is not null
        and length("build_checks"."conflict_reason") between 1 and 255)
      or ("build_checks"."evidence_state" <> 'conflict' and "build_checks"."conflict_reason" is null));--> statement-breakpoint
ALTER TABLE "pr_links" ADD CONSTRAINT "pr_links_evidence_state_valid" CHECK ("pr_links"."evidence_state" in (
        'observed', 'pending_confirmation', 'confirmed', 'stale', 'conflict', 'missing'
      ));--> statement-breakpoint
ALTER TABLE "pr_links" ADD CONSTRAINT "pr_links_conflict_reason_valid" CHECK (("pr_links"."evidence_state" = 'conflict'
        and "pr_links"."conflict_reason" is not null
        and length("pr_links"."conflict_reason") between 1 and 255)
      or ("pr_links"."evidence_state" <> 'conflict' and "pr_links"."conflict_reason" is null));--> statement-breakpoint
ALTER TABLE "tracker_bindings" ADD CONSTRAINT "tracker_bindings_evidence_state_valid" CHECK ("tracker_bindings"."evidence_state" in (
        'observed', 'pending_confirmation', 'confirmed', 'stale', 'conflict', 'missing'
      ));--> statement-breakpoint
ALTER TABLE "tracker_bindings" ADD CONSTRAINT "tracker_bindings_conflict_reason_valid" CHECK (("tracker_bindings"."evidence_state" = 'conflict'
        and "tracker_bindings"."conflict_reason" is not null
        and length("tracker_bindings"."conflict_reason") between 1 and 255)
      or ("tracker_bindings"."evidence_state" <> 'conflict' and "tracker_bindings"."conflict_reason" is null));
