CREATE TABLE "workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "workspaces_slug_unique" UNIQUE ("slug")
);

CREATE TABLE "actors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "kind" text NOT NULL,
  "display_name" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "actors_kind_check" CHECK ("kind" IN ('human', 'agent', 'system'))
);
CREATE INDEX "actors_workspace_idx" ON "actors" ("workspace_id");

CREATE TABLE "oauth_login_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "state_hash" text NOT NULL,
  "verifier_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_login_attempts_state_unique" UNIQUE ("state_hash")
);

CREATE TABLE "operator_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "actors"("id"),
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "operator_sessions_token_unique" UNIQUE ("token_hash")
);

CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "repository_url" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "projects_workspace_slug_unique" UNIQUE ("workspace_id", "slug")
);

CREATE TABLE "project_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id"),
  "actor_id" uuid NOT NULL REFERENCES "actors"("id"),
  "role" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "project_memberships_actor_unique" UNIQUE ("project_id", "actor_id"),
  CONSTRAINT "project_memberships_role_check" CHECK ("role" IN ('project_owner', 'operator', 'contributor', 'client'))
);

CREATE TABLE "actor_external_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "actors"("id"),
  "provider" text NOT NULL,
  "subject_hash" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "actor_external_identities_subject_unique" UNIQUE ("provider", "subject_hash")
);
CREATE INDEX "actor_external_identities_actor_idx" ON "actor_external_identities" ("actor_id");

CREATE TABLE "project_source_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id"),
  "created_by_actor_id" uuid NOT NULL REFERENCES "actors"("id"),
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "media_type" text NOT NULL,
  "sha256" text NOT NULL,
  "content_text" text,
  "content_bytes" bytea,
  "size_bytes" bigint GENERATED ALWAYS AS (coalesce(octet_length("content_bytes"), octet_length("content_text"))) STORED,
  "source_url" text,
  "provenance" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "project_source_artifacts_kind_hash_unique" UNIQUE ("project_id", "kind", "sha256"),
  CONSTRAINT "project_source_artifacts_payload_check" CHECK (
    ("content_text" IS NOT NULL AND "content_bytes" IS NULL) OR
    ("content_text" IS NULL AND "content_bytes" IS NOT NULL AND octet_length("content_bytes") BETWEEN 1 AND 52428800)
  )
);

CREATE TABLE "secret_refs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "purpose" text NOT NULL,
  "locator" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "secret_refs_purpose_unique" UNIQUE ("workspace_id", "purpose")
);

CREATE TABLE "tracker_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id"),
  "secret_ref_id" uuid NOT NULL REFERENCES "secret_refs"("id"),
  "provider" text NOT NULL,
  "external_project_id" text NOT NULL,
  "project_url" text NOT NULL,
  "repository_id" text NOT NULL,
  "repository_url" text NOT NULL,
  "cursor" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "tracker_bindings_project_unique" UNIQUE ("project_id")
);

CREATE TABLE "tracker_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "binding_id" uuid NOT NULL REFERENCES "tracker_bindings"("id"),
  "external_version" text NOT NULL,
  "cursor" text,
  "source_url" text NOT NULL,
  "facts" jsonb NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "error_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "tracker_snapshots_version_unique" UNIQUE ("binding_id", "external_version")
);

CREATE TABLE "incoming_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id"),
  "provider" text NOT NULL,
  "provider_delivery_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload_hash" text NOT NULL,
  "received_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "incoming_events_delivery_unique" UNIQUE ("provider", "provider_delivery_id")
);

CREATE TABLE "approval_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id"),
  "actor_id" uuid NOT NULL REFERENCES "actors"("id"),
  "kind" text NOT NULL,
  "decision" text NOT NULL,
  "target_reference" text NOT NULL,
  "target_url" text NOT NULL,
  "target_version" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "decided_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "approval_evidence_idempotency_unique" UNIQUE ("idempotency_key"),
  CONSTRAINT "approval_evidence_kind_check" CHECK ("kind" IN ('plan', 'internal_operation', 'production', 'acceptance', 'client_uat')),
  CONSTRAINT "approval_evidence_decision_check" CHECK ("decision" IN ('approved', 'rejected'))
);

CREATE TABLE "command_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id"),
  "actor_id" uuid REFERENCES "actors"("id"),
  "idempotency_key" text NOT NULL,
  "command_type" text NOT NULL,
  "result_reference" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "command_receipts_idempotency_unique" UNIQUE ("idempotency_key")
);

CREATE TABLE "outbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id"),
  "topic" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" timestamptz NOT NULL,
  "claimed_at" timestamptz,
  "delivered_at" timestamptz,
  "delivery_reference" text,
  "last_error_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "outbox_events_idempotency_unique" UNIQUE ("idempotency_key"),
  CONSTRAINT "outbox_events_topic_check" CHECK ("topic" = 'messenger-notification'),
  CONSTRAINT "outbox_events_attempts_check" CHECK ("attempts" >= 0)
);
CREATE INDEX "outbox_events_ready_idx" ON "outbox_events" ("available_at", "delivered_at");

CREATE TABLE "audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "project_id" uuid REFERENCES "projects"("id"),
  "actor_id" uuid REFERENCES "actors"("id"),
  "action" text NOT NULL,
  "target_reference" text NOT NULL,
  "correlation_id" text NOT NULL,
  "details" jsonb NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "audit_events_project_time_idx" ON "audit_events" ("project_id", "occurred_at");
CREATE INDEX "audit_events_attempt_lifecycle_idx" ON "audit_events" ("project_id", "action", "target_reference", "occurred_at");
