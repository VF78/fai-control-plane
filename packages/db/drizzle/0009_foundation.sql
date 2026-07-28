ALTER TABLE "incoming_events" ADD COLUMN "telegram_message_id" text;--> statement-breakpoint
ALTER TABLE "incoming_events" ADD COLUMN "telegram_chat_id" text;--> statement-breakpoint
ALTER TABLE "incoming_events" ADD COLUMN "telegram_user_id" text;--> statement-breakpoint
ALTER TABLE "incoming_events" ADD CONSTRAINT "incoming_events_telegram_verified_source" CHECK ("incoming_events"."provider" <> 'telegram' or (
        "incoming_events"."verification" = '{"outcome":"verified","method":"shared-token"}'::jsonb
        and "incoming_events"."installation_id" is null
        and "incoming_events"."repository_id" is null
        and "incoming_events"."project_node_id" is null
        and "incoming_events"."telegram_message_id" ~ '^tgid:v1:[0-9a-f]{64}$'
        and "incoming_events"."telegram_chat_id" ~ '^tgid:v1:[0-9a-f]{64}$'
        and "incoming_events"."telegram_user_id" ~ '^tgid:v1:[0-9a-f]{64}$'
      ));