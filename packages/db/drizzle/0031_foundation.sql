ALTER TABLE "agent_runs" ADD COLUMN "work_item_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "repository_scope_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "retry_of_agent_run_id" uuid;--> statement-breakpoint
UPDATE "agent_runs" AS run
SET
  "work_item_id" = packet."work_item_id",
  "repository_scope_id" = (
    SELECT scope."id"
    FROM "project_tracker_repository_scopes" AS scope
    WHERE scope."project_id" = packet."project_id"
    ORDER BY scope."id"
    LIMIT 1
  )
FROM "task_packets" AS packet
WHERE packet."id" = run."task_packet_id"
  AND (
    SELECT count(*)
    FROM "project_tracker_repository_scopes" AS scope
    WHERE scope."project_id" = packet."project_id"
  ) = 1;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_runs"
    WHERE "work_item_id" IS NULL OR "repository_scope_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'agent_run_attempt_guard_requires_exactly_one_repository_scope_per_existing_run';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "agent_runs"
    WHERE "status" IN ('queued', 'running', 'waiting_approval')
    GROUP BY "work_item_id", "repository_scope_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'agent_run_attempt_guard_refuses_existing_active_attempt_conflict';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "work_item_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "repository_scope_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_repository_scope_id_project_tracker_repository_scopes_id_fk" FOREIGN KEY ("repository_scope_id") REFERENCES "public"."project_tracker_repository_scopes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_retry_of_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("retry_of_agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_active_attempt_unique" ON "agent_runs" USING btree ("work_item_id","repository_scope_id") WHERE "agent_runs"."status" in ('queued', 'running', 'waiting_approval');--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_retry_not_self" CHECK ("agent_runs"."retry_of_agent_run_id" is null or "agent_runs"."retry_of_agent_run_id" <> "agent_runs"."id");
