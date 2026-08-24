CREATE INDEX IF NOT EXISTS "audit_events_attempt_lifecycle_idx"
ON "audit_events" ("project_id", "action", "target_reference", "occurred_at");
