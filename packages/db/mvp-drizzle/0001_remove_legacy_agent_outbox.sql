-- Approved MVP cleanup: agent execution is synchronous and explicit, never an outbox topic.
DELETE FROM "outbox_events" WHERE "topic" = 'agent-role-request';
ALTER TABLE "outbox_events" DROP CONSTRAINT IF EXISTS "outbox_events_topic_check";
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_topic_check"
  CHECK ("topic" = 'messenger-notification');
