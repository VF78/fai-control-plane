-- Destructive cleanup approved in #171. Production execution is gated by the
-- encrypted 30-day backup procedure in docs/ops/PRODUCTION_RUNBOOK.md.
DROP TABLE "resource_access_grants";--> statement-breakpoint
DROP TABLE "access_requests";--> statement-breakpoint
DROP TABLE "project_environments";--> statement-breakpoint
DROP TYPE "public"."access_level";--> statement-breakpoint
DROP TYPE "public"."access_request_status";--> statement-breakpoint
DROP TYPE "public"."access_resource_type";
