CREATE TABLE "agent_run_receipts" (
	"agent_run_id" uuid PRIMARY KEY NOT NULL,
	"runner_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"terminal" "agent_run_status" NOT NULL,
	"receipt_sha256" text NOT NULL,
	"receipt_size_bytes" bigint NOT NULL,
	"completion_replay_hash" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_receipts_terminal_status" CHECK ("agent_run_receipts"."terminal" in ('done', 'failed')),
	CONSTRAINT "agent_run_receipts_attempt_positive" CHECK ("agent_run_receipts"."attempt" > 0),
	CONSTRAINT "agent_run_receipts_sha256" CHECK ("agent_run_receipts"."receipt_sha256" ~ '^[0-9a-f]{64}$' and "agent_run_receipts"."completion_replay_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_run_receipts_size_positive" CHECK ("agent_run_receipts"."receipt_size_bytes" > 0 and "agent_run_receipts"."receipt_size_bytes" <= 1048576),
	CONSTRAINT "agent_run_receipts_runner_id_nonempty" CHECK (length("agent_run_receipts"."runner_id") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "agent_run_receipts" ADD CONSTRAINT "agent_run_receipts_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;