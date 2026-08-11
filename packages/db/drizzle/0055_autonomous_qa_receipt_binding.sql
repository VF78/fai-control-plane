ALTER TABLE "qa_review_receipts" ADD COLUMN "agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "qa_review_receipts" ADD COLUMN "agent_run_attempt" integer;--> statement-breakpoint
ALTER TABLE "qa_review_receipts" ADD COLUMN "agent_run_receipt_sha256" text;--> statement-breakpoint
ALTER TABLE "qa_review_receipts" ADD CONSTRAINT "qa_review_receipts_run_packet_fk" FOREIGN KEY ("agent_run_id","task_packet_id") REFERENCES "public"."agent_runs"("id","task_packet_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qa_review_receipts_agent_run_unique" ON "qa_review_receipts" USING btree ("agent_run_id");--> statement-breakpoint
ALTER TABLE "qa_review_receipts" ADD CONSTRAINT "qa_review_receipts_machine_binding_complete" CHECK (
      num_nonnulls("qa_review_receipts"."agent_run_id", "qa_review_receipts"."agent_run_attempt", "qa_review_receipts"."agent_run_receipt_sha256") = 0
      or (num_nonnulls("qa_review_receipts"."agent_run_id", "qa_review_receipts"."agent_run_attempt", "qa_review_receipts"."agent_run_receipt_sha256") = 3
        and "qa_review_receipts"."agent_run_attempt" > 0 and "qa_review_receipts"."agent_run_receipt_sha256" ~ '^[0-9a-f]{64}$')
    );