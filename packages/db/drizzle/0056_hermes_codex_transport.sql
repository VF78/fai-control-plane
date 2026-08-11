ALTER TABLE "project_execution_dispatches" ADD COLUMN "work_order" jsonb;--> statement-breakpoint
ALTER TABLE "project_execution_dispatches" ADD COLUMN "work_order_hash" text;--> statement-breakpoint
ALTER TABLE "project_execution_dispatches" ADD COLUMN "orchestrator_runtime_id" text;--> statement-breakpoint
ALTER TABLE "project_execution_dispatches" ADD COLUMN "executor_runtime_id" text;--> statement-breakpoint
ALTER TABLE "project_execution_dispatches" ADD CONSTRAINT "project_execution_dispatches_composed_runtime_consistent" CHECK (
      num_nonnulls("project_execution_dispatches"."work_order", "project_execution_dispatches"."work_order_hash", "project_execution_dispatches"."orchestrator_runtime_id", "project_execution_dispatches"."executor_runtime_id") = 0
      or (num_nonnulls("project_execution_dispatches"."work_order", "project_execution_dispatches"."work_order_hash", "project_execution_dispatches"."orchestrator_runtime_id", "project_execution_dispatches"."executor_runtime_id") = 4
        and jsonb_typeof("project_execution_dispatches"."work_order") = 'object'
        and "project_execution_dispatches"."work_order_hash" ~ '^[0-9a-f]{64}$'
        and "project_execution_dispatches"."orchestrator_runtime_id" = 'hermes'
        and "project_execution_dispatches"."executor_runtime_id" = 'codex-cli')
    );