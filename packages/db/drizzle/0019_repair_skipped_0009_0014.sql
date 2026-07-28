DO $$
DECLARE
  required_column text;
  has_rows boolean;
  has_nulls boolean;
BEGIN
  IF to_regclass('public.approval_requests') IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM "approval_requests") INTO has_rows;

    IF has_rows THEN
      FOREACH required_column IN ARRAY ARRAY[
        'expires_at',
        'subject_hash',
        'policy_version',
        'execution_identity',
        'action_hash'
      ]
      LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM pg_attribute
          WHERE attrelid = 'public.approval_requests'::regclass
            AND attname = required_column
            AND NOT attisdropped
        ) THEN
          RAISE EXCEPTION
            'repair_skipped_0009_0014_requires_empty_approval_requests_missing_%',
            required_column;
        END IF;

        EXECUTE format(
          'SELECT EXISTS (SELECT 1 FROM public.approval_requests WHERE %I IS NULL)',
          required_column
        ) INTO has_nulls;

        IF has_nulls THEN
          RAISE EXCEPTION
            'repair_skipped_0009_0014_refuses_null_approval_requests_%',
            required_column;
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF to_regclass('public.agent_runs') IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM "agent_runs") INTO has_rows;

    IF has_rows THEN
      FOREACH required_column IN ARRAY ARRAY['base_commit', 'attempt']
      LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM pg_attribute
          WHERE attrelid = 'public.agent_runs'::regclass
            AND attname = required_column
            AND NOT attisdropped
        ) THEN
          RAISE EXCEPTION
            'repair_skipped_0009_0014_requires_empty_agent_runs_missing_%',
            required_column;
        END IF;

        EXECUTE format(
          'SELECT EXISTS (SELECT 1 FROM public.agent_runs WHERE %I IS NULL)',
          required_column
        ) INTO has_nulls;

        IF has_nulls THEN
          RAISE EXCEPTION
            'repair_skipped_0009_0014_refuses_null_agent_runs_%',
            required_column;
        END IF;
      END LOOP;
    END IF;
  END IF;
END;
$$;
--> statement-breakpoint

ALTER TABLE "incoming_events"
  ADD COLUMN IF NOT EXISTS "telegram_message_id" text;
--> statement-breakpoint
ALTER TABLE "incoming_events"
  ADD COLUMN IF NOT EXISTS "telegram_chat_id" text;
--> statement-breakpoint
ALTER TABLE "incoming_events"
  ADD COLUMN IF NOT EXISTS "telegram_user_id" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.incoming_events'::regclass
      AND conname = 'incoming_events_telegram_verified_source'
  ) THEN
    ALTER TABLE "incoming_events"
      ADD CONSTRAINT "incoming_events_telegram_verified_source"
      CHECK ("incoming_events"."provider" <> 'telegram' or (
        "incoming_events"."verification" = '{"outcome":"verified","method":"shared-token"}'::jsonb
        and "incoming_events"."installation_id" is null
        and "incoming_events"."repository_id" is null
        and "incoming_events"."project_node_id" is null
        and "incoming_events"."telegram_message_id" ~ '^tgid:v1:[0-9a-f]{64}$'
        and "incoming_events"."telegram_chat_id" ~ '^tgid:v1:[0-9a-f]{64}$'
        and "incoming_events"."telegram_user_id" ~ '^tgid:v1:[0-9a-f]{64}$'
      ));
  END IF;
END;
$$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "oauth_login_attempts" (
  "state_hash" text PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  CONSTRAINT "oauth_login_attempts_state_hash_sha256"
    CHECK ("oauth_login_attempts"."state_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "oauth_login_attempts_expiry_after_creation"
    CHECK ("oauth_login_attempts"."expires_at" > "oauth_login_attempts"."created_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operator_sessions" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "actor_id" uuid NOT NULL,
  "github_user_id" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone NOT NULL,
  CONSTRAINT "operator_sessions_token_hash_sha256"
    CHECK ("operator_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "operator_sessions_github_user_id_positive"
    CHECK ("operator_sessions"."github_user_id" > 0),
  CONSTRAINT "operator_sessions_expiry_after_creation"
    CHECK ("operator_sessions"."expires_at" > "operator_sessions"."created_at"),
  CONSTRAINT "operator_sessions_last_seen_after_creation"
    CHECK ("operator_sessions"."last_seen_at" >= "operator_sessions"."created_at")
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.oauth_login_attempts'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE "oauth_login_attempts"
      ADD CONSTRAINT "oauth_login_attempts_pkey" PRIMARY KEY ("state_hash");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.oauth_login_attempts'::regclass
      AND conname = 'oauth_login_attempts_state_hash_sha256'
  ) THEN
    ALTER TABLE "oauth_login_attempts"
      ADD CONSTRAINT "oauth_login_attempts_state_hash_sha256"
      CHECK ("oauth_login_attempts"."state_hash" ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.oauth_login_attempts'::regclass
      AND conname = 'oauth_login_attempts_expiry_after_creation'
  ) THEN
    ALTER TABLE "oauth_login_attempts"
      ADD CONSTRAINT "oauth_login_attempts_expiry_after_creation"
      CHECK ("oauth_login_attempts"."expires_at" > "oauth_login_attempts"."created_at");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_sessions'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE "operator_sessions"
      ADD CONSTRAINT "operator_sessions_pkey" PRIMARY KEY ("token_hash");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_sessions'::regclass
      AND conname = 'operator_sessions_token_hash_sha256'
  ) THEN
    ALTER TABLE "operator_sessions"
      ADD CONSTRAINT "operator_sessions_token_hash_sha256"
      CHECK ("operator_sessions"."token_hash" ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_sessions'::regclass
      AND conname = 'operator_sessions_github_user_id_positive'
  ) THEN
    ALTER TABLE "operator_sessions"
      ADD CONSTRAINT "operator_sessions_github_user_id_positive"
      CHECK ("operator_sessions"."github_user_id" > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_sessions'::regclass
      AND conname = 'operator_sessions_expiry_after_creation'
  ) THEN
    ALTER TABLE "operator_sessions"
      ADD CONSTRAINT "operator_sessions_expiry_after_creation"
      CHECK ("operator_sessions"."expires_at" > "operator_sessions"."created_at");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_sessions'::regclass
      AND conname = 'operator_sessions_last_seen_after_creation'
  ) THEN
    ALTER TABLE "operator_sessions"
      ADD CONSTRAINT "operator_sessions_last_seen_after_creation"
      CHECK ("operator_sessions"."last_seen_at" >= "operator_sessions"."created_at");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_sessions'::regclass
      AND conname = 'operator_sessions_actor_id_actors_id_fk'
  ) THEN
    ALTER TABLE "operator_sessions"
      ADD CONSTRAINT "operator_sessions_actor_id_actors_id_fk"
      FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_login_attempts_expires_idx"
  ON "oauth_login_attempts" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operator_sessions_actor_idx"
  ON "operator_sessions" USING btree ("actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "operator_sessions_expires_idx"
  ON "operator_sessions" USING btree ("expires_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "daily_pm_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "report_date" date NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.daily_pm_reports'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE "daily_pm_reports"
      ADD CONSTRAINT "daily_pm_reports_pkey" PRIMARY KEY ("id");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.daily_pm_reports'::regclass
      AND conname = 'daily_pm_reports_project_id_projects_id_fk'
  ) THEN
    ALTER TABLE "daily_pm_reports"
      ADD CONSTRAINT "daily_pm_reports_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
      ON DELETE restrict ON UPDATE no action;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_pm_reports_project_date_unique"
  ON "daily_pm_reports" USING btree ("project_id", "report_date");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION daily_pm_reports_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'daily_pm_reports_are_immutable';
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.daily_pm_reports'::regclass
      AND tgname = 'daily_pm_reports_immutable'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER daily_pm_reports_immutable
    BEFORE UPDATE OR DELETE ON "daily_pm_reports"
    FOR EACH ROW
    EXECUTE FUNCTION daily_pm_reports_immutable();
  END IF;
END;
$$;
--> statement-breakpoint

ALTER TABLE "approval_requests"
  ADD COLUMN IF NOT EXISTS "subject_hash" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_requests"
  ADD COLUMN IF NOT EXISTS "policy_version" integer NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_requests"
  ADD COLUMN IF NOT EXISTS "execution_identity" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_requests"
  ADD COLUMN IF NOT EXISTS "action_hash" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_requests"
  ALTER COLUMN "expires_at" SET NOT NULL,
  ALTER COLUMN "subject_hash" SET NOT NULL,
  ALTER COLUMN "policy_version" SET NOT NULL,
  ALTER COLUMN "execution_identity" SET NOT NULL,
  ALTER COLUMN "action_hash" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_agent_run_binding_idx"
  ON "approval_requests" USING btree (
    "agent_run_id",
    "subject_hash",
    "action_hash",
    "status",
    "expires_at"
  );
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.approval_requests'::regclass
      AND conname = 'approval_requests_execution_identity_target'
  ) THEN
    ALTER TABLE "approval_requests"
      ADD CONSTRAINT "approval_requests_execution_identity_target"
      CHECK ("approval_requests"."agent_run_id" is null
        or "approval_requests"."execution_identity" = "approval_requests"."agent_run_id");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.approval_requests'::regclass
      AND conname = 'approval_requests_subject_hash_sha256'
  ) THEN
    ALTER TABLE "approval_requests"
      ADD CONSTRAINT "approval_requests_subject_hash_sha256"
      CHECK ("approval_requests"."subject_hash" ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.approval_requests'::regclass
      AND conname = 'approval_requests_action_hash_sha256'
  ) THEN
    ALTER TABLE "approval_requests"
      ADD CONSTRAINT "approval_requests_action_hash_sha256"
      CHECK ("approval_requests"."action_hash" ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.approval_requests'::regclass
      AND conname = 'approval_requests_policy_version_positive'
  ) THEN
    ALTER TABLE "approval_requests"
      ADD CONSTRAINT "approval_requests_policy_version_positive"
      CHECK ("approval_requests"."policy_version" > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.approval_requests'::regclass
      AND conname = 'approval_requests_expiry_bounded'
  ) THEN
    ALTER TABLE "approval_requests"
      ADD CONSTRAINT "approval_requests_expiry_bounded"
      CHECK ("approval_requests"."expires_at" > "approval_requests"."created_at"
        and "approval_requests"."expires_at"
          <= "approval_requests"."created_at" + interval '24 hours');
  END IF;
END;
$$;
--> statement-breakpoint

ALTER TABLE "agent_runs"
  ADD COLUMN IF NOT EXISTS "base_commit" text NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_runs"
  ADD COLUMN IF NOT EXISTS "runner_id" text;
--> statement-breakpoint
ALTER TABLE "agent_runs"
  ADD COLUMN IF NOT EXISTS "lease_token_hash" text;
--> statement-breakpoint
ALTER TABLE "agent_runs"
  ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_runs"
  ADD COLUMN IF NOT EXISTS "attempt" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_runs"
  ALTER COLUMN "base_commit" SET NOT NULL,
  ALTER COLUMN "attempt" SET DEFAULT 0,
  ALTER COLUMN "attempt" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_claim_order_idx"
  ON "agent_runs" USING btree ("status", "created_at");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_runs'::regclass
      AND conname = 'agent_runs_attempt_nonnegative'
  ) THEN
    ALTER TABLE "agent_runs"
      ADD CONSTRAINT "agent_runs_attempt_nonnegative"
      CHECK ("agent_runs"."attempt" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_runs'::regclass
      AND conname = 'agent_runs_base_commit_sha1'
  ) THEN
    ALTER TABLE "agent_runs"
      ADD CONSTRAINT "agent_runs_base_commit_sha1"
      CHECK ("agent_runs"."base_commit" ~ '^[0-9a-f]{40}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_runs'::regclass
      AND conname = 'agent_runs_lease_token_hash_sha256'
  ) THEN
    ALTER TABLE "agent_runs"
      ADD CONSTRAINT "agent_runs_lease_token_hash_sha256"
      CHECK ("agent_runs"."lease_token_hash" is null
        or "agent_runs"."lease_token_hash" ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_runs'::regclass
      AND conname = 'agent_runs_lease_fields_together'
  ) THEN
    ALTER TABLE "agent_runs"
      ADD CONSTRAINT "agent_runs_lease_fields_together"
      CHECK (num_nonnulls(
        "agent_runs"."runner_id",
        "agent_runs"."lease_token_hash",
        "agent_runs"."lease_expires_at"
      ) in (0, 3));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_runs'::regclass
      AND conname = 'agent_runs_runner_id_nonempty'
  ) THEN
    ALTER TABLE "agent_runs"
      ADD CONSTRAINT "agent_runs_runner_id_nonempty"
      CHECK ("agent_runs"."runner_id" is null
        or length("agent_runs"."runner_id") between 1 and 128);
  END IF;
END;
$$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_run_receipts" (
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
  CONSTRAINT "agent_run_receipts_terminal_status"
    CHECK ("agent_run_receipts"."terminal" in ('done', 'failed')),
  CONSTRAINT "agent_run_receipts_attempt_positive"
    CHECK ("agent_run_receipts"."attempt" > 0),
  CONSTRAINT "agent_run_receipts_sha256"
    CHECK ("agent_run_receipts"."receipt_sha256" ~ '^[0-9a-f]{64}$'
      and "agent_run_receipts"."completion_replay_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "agent_run_receipts_size_positive"
    CHECK ("agent_run_receipts"."receipt_size_bytes" > 0
      and "agent_run_receipts"."receipt_size_bytes" <= 1048576),
  CONSTRAINT "agent_run_receipts_runner_id_nonempty"
    CHECK (length("agent_run_receipts"."runner_id") between 1 and 128)
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_run_receipts'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE "agent_run_receipts"
      ADD CONSTRAINT "agent_run_receipts_pkey" PRIMARY KEY ("agent_run_id");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_run_receipts'::regclass
      AND conname = 'agent_run_receipts_terminal_status'
  ) THEN
    ALTER TABLE "agent_run_receipts"
      ADD CONSTRAINT "agent_run_receipts_terminal_status"
      CHECK ("agent_run_receipts"."terminal" in ('done', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_run_receipts'::regclass
      AND conname = 'agent_run_receipts_attempt_positive'
  ) THEN
    ALTER TABLE "agent_run_receipts"
      ADD CONSTRAINT "agent_run_receipts_attempt_positive"
      CHECK ("agent_run_receipts"."attempt" > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_run_receipts'::regclass
      AND conname = 'agent_run_receipts_sha256'
  ) THEN
    ALTER TABLE "agent_run_receipts"
      ADD CONSTRAINT "agent_run_receipts_sha256"
      CHECK ("agent_run_receipts"."receipt_sha256" ~ '^[0-9a-f]{64}$'
        and "agent_run_receipts"."completion_replay_hash" ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_run_receipts'::regclass
      AND conname = 'agent_run_receipts_size_positive'
  ) THEN
    ALTER TABLE "agent_run_receipts"
      ADD CONSTRAINT "agent_run_receipts_size_positive"
      CHECK ("agent_run_receipts"."receipt_size_bytes" > 0
        and "agent_run_receipts"."receipt_size_bytes" <= 1048576);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_run_receipts'::regclass
      AND conname = 'agent_run_receipts_runner_id_nonempty'
  ) THEN
    ALTER TABLE "agent_run_receipts"
      ADD CONSTRAINT "agent_run_receipts_runner_id_nonempty"
      CHECK (length("agent_run_receipts"."runner_id") between 1 and 128);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_run_receipts'::regclass
      AND conname = 'agent_run_receipts_agent_run_id_agent_runs_id_fk'
  ) THEN
    ALTER TABLE "agent_run_receipts"
      ADD CONSTRAINT "agent_run_receipts_agent_run_id_agent_runs_id_fk"
      FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id")
      ON DELETE restrict ON UPDATE no action;
  END IF;
END;
$$;
