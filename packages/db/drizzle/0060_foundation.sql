-- Destructive cleanup approved in #169. Production execution is gated by the
-- encrypted 30-day backup procedure in docs/ops/PRODUCTION_RUNBOOK.md.
DELETE FROM "canonical_events"
WHERE "incoming_event_id" IN (
  SELECT "id" FROM "incoming_events" WHERE "provider" = 'telegram'
) OR "event_type" = 'chat.command.status.requested';--> statement-breakpoint
DELETE FROM "incoming_events" WHERE "provider" = 'telegram';--> statement-breakpoint
DELETE FROM "outbox_events"
WHERE "destination" = 'telegram' OR "event_type" = 'telegram.status.response.v1';--> statement-breakpoint
DELETE FROM "actor_external_identities" WHERE "provider" = 'telegram';--> statement-breakpoint
DELETE FROM "resource_access_grants"
WHERE "resource_type"::text IN ('internal_chat', 'client_chat');--> statement-breakpoint
DELETE FROM "access_requests"
WHERE "resource_type"::text IN ('internal_chat', 'client_chat');--> statement-breakpoint
DROP TABLE "project_share_work_items";--> statement-breakpoint
DROP TABLE "project_share_grants";--> statement-breakpoint
DROP TABLE "conversation_messages";--> statement-breakpoint
DROP TABLE "conversation_participants";--> statement-breakpoint
DROP TABLE "conversation_bindings";--> statement-breakpoint
DROP TABLE "conversation_channel_configurations";--> statement-breakpoint
ALTER TABLE "incoming_events" DROP CONSTRAINT "incoming_events_telegram_verified_source";--> statement-breakpoint
ALTER TABLE "incoming_events" DROP CONSTRAINT "incoming_events_verification_envelope_valid";--> statement-breakpoint
ALTER TABLE "access_requests" DROP CONSTRAINT "access_requests_environment_binding_complete";--> statement-breakpoint
ALTER TABLE "resource_access_grants" DROP CONSTRAINT "resource_access_grants_environment_binding_complete";--> statement-breakpoint
ALTER TABLE "resource_access_grants" DROP CONSTRAINT "resource_access_grants_environment_observed_level";--> statement-breakpoint
ALTER TABLE "access_requests" ALTER COLUMN "resource_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "resource_access_grants" ALTER COLUMN "resource_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."access_resource_type";--> statement-breakpoint
CREATE TYPE "public"."access_resource_type" AS ENUM('repository', 'tracker', 'environment', 'control_plane_action');--> statement-breakpoint
ALTER TABLE "access_requests" ALTER COLUMN "resource_type" SET DATA TYPE "public"."access_resource_type" USING "resource_type"::"public"."access_resource_type";--> statement-breakpoint
ALTER TABLE "resource_access_grants" ALTER COLUMN "resource_type" SET DATA TYPE "public"."access_resource_type" USING "resource_type"::"public"."access_resource_type";--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_environment_binding_complete" CHECK (
      ("access_requests"."resource_type" is null and "access_requests"."project_id" is null and "access_requests"."subject_actor_id" is null and
       "access_requests"."resource_id" is null and "access_requests"."requested_level" is null and "access_requests"."credential_ref_id" is null)
      or
      ("access_requests"."resource_type" = 'environment' and "access_requests"."project_id" is not null and
       "access_requests"."subject_actor_id" is not null and "access_requests"."resource_id" is not null and
       "access_requests"."requested_level" = 'write' and "access_requests"."credential_ref_id" is not null and "access_requests"."expires_at" is not null)
    );--> statement-breakpoint
ALTER TABLE "resource_access_grants" ADD CONSTRAINT "resource_access_grants_environment_binding_complete" CHECK (
      ("resource_access_grants"."resource_type" <> 'environment' and "resource_access_grants"."credential_ref_id" is null and
       "resource_access_grants"."approval_request_id" is null and "resource_access_grants"."expires_at" is null)
      or
      ("resource_access_grants"."resource_type" = 'environment' and "resource_access_grants"."desired_level" = 'none' and
       "resource_access_grants"."approval_request_id" is null and "resource_access_grants"."expires_at" is null)
      or
      ("resource_access_grants"."resource_type" = 'environment' and "resource_access_grants"."desired_level" = 'write' and
       "resource_access_grants"."credential_ref_id" is not null and "resource_access_grants"."expires_at" is not null)
    );--> statement-breakpoint
ALTER TABLE "resource_access_grants" ADD CONSTRAINT "resource_access_grants_environment_observed_level" CHECK (
      "resource_access_grants"."resource_type" <> 'environment' or "resource_access_grants"."observed_level" is null or
      "resource_access_grants"."observed_level" in ('none', 'write')
    );--> statement-breakpoint
ALTER TABLE "incoming_events" DROP COLUMN "telegram_message_id";--> statement-breakpoint
ALTER TABLE "incoming_events" DROP COLUMN "telegram_chat_id";--> statement-breakpoint
ALTER TABLE "incoming_events" DROP COLUMN "telegram_user_id";--> statement-breakpoint
ALTER TABLE "incoming_events" ADD CONSTRAINT "incoming_events_verification_envelope_valid" CHECK ("incoming_events"."verification" in (
        '{"outcome":"unverified","method":"none"}'::jsonb,
        '{"outcome":"verified","method":"hmac-sha256"}'::jsonb,
        '{"outcome":"verified","method":"signature-sha256"}'::jsonb,
        '{"outcome":"rejected","method":"hmac-sha256"}'::jsonb,
        '{"outcome":"rejected","method":"signature-sha256"}'::jsonb
      ));--> statement-breakpoint
DROP TYPE "public"."conversation_channel_state";--> statement-breakpoint
DROP TYPE "public"."conversation_class";
