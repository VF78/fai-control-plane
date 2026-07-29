CREATE TYPE "public"."risk_signal_class" AS ENUM('fact', 'inference');--> statement-breakpoint
ALTER TABLE "risk_signals" ADD COLUMN "rule_id" text;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD COLUMN "rule_version" text;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD COLUMN "signal_class" "risk_signal_class";--> statement-breakpoint
ALTER TABLE "risk_signals" ADD COLUMN "evidence_references" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD COLUMN "impact" text;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD COLUMN "owner_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD COLUMN "next_action" text;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD COLUMN "deduplication_key" text;--> statement-breakpoint
UPDATE "risk_signals" SET
  "rule_id" = COALESCE(NULLIF("code", ''), 'legacy_risk_signal'),
  "rule_version" = COALESCE(NULLIF("details"->>'ruleVersion', ''), 'legacy-v1'),
  "signal_class" = 'inference',
  "impact" = COALESCE(NULLIF("summary", ''), 'Legacy risk signal requires review.'),
  "next_action" = COALESCE(NULLIF("details"->>'nextAction', ''), 'review_risk_signal'),
  "observed_at" = "created_at",
  "deduplication_key" = COALESCE(NULLIF("code", ''), 'legacy_risk_signal')
    || CASE WHEN "work_item_id" IS NULL THEN '' ELSE ':work_item:' || "work_item_id"::text END
    || CASE WHEN "agent_run_id" IS NULL THEN '' ELSE ':agent_run:' || "agent_run_id"::text END;--> statement-breakpoint
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "project_id", "deduplication_key"
    ORDER BY "created_at", "id"
  ) AS position
  FROM "risk_signals"
  WHERE "resolved_at" IS NULL
)
UPDATE "risk_signals" AS signals
SET "resolved_at" = COALESCE(signals."updated_at", signals."created_at")
FROM ranked
WHERE signals."id" = ranked."id" AND ranked.position > 1;--> statement-breakpoint
ALTER TABLE "risk_signals" ALTER COLUMN "rule_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_signals" ALTER COLUMN "rule_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_signals" ALTER COLUMN "signal_class" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_signals" ALTER COLUMN "impact" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_signals" ALTER COLUMN "next_action" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_signals" ALTER COLUMN "observed_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_signals" ALTER COLUMN "deduplication_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD CONSTRAINT "risk_signals_owner_actor_id_actors_id_fk" FOREIGN KEY ("owner_actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_signals_project_unresolved_dedup_unique" ON "risk_signals" USING btree ("project_id","deduplication_key") WHERE "risk_signals"."resolved_at" is null;
