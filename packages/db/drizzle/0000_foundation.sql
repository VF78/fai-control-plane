CREATE TYPE "public"."access_request_status" AS ENUM('pending', 'granted', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."action_category" AS ENUM('read', 'write', 'delete', 'external_message', 'deploy', 'access_change', 'critical_config', 'customer_data_touch');--> statement-breakpoint
CREATE TYPE "public"."actor_role" AS ENUM('workspace_admin', 'delivery_lead', 'developer', 'agent_operator');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('human', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."auth_mode" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('pending', 'processing', 'processed', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."scheduled_job_status" AS ENUM('active', 'paused', 'unhealthy');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'publishing', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."policy_decision" AS ENUM('allow', 'ask', 'deny');--> statement-breakpoint
CREATE TYPE "public"."risk_severity" AS ENUM('green', 'yellow', 'red');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'waiting_approval', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."work_item_status" AS ENUM('backlog', 'ready', 'in_dev', 'qa', 'acceptance', 'done');--> statement-breakpoint
CREATE TABLE "access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requester_actor_id" uuid NOT NULL,
	"target_surface" text NOT NULL,
	"requested_scope" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "access_request_status" DEFAULT 'pending' NOT NULL,
	"decided_by_actor_id" uuid,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "actor_type" NOT NULL,
	"role" "actor_role" NOT NULL,
	"display_name" text NOT NULL,
	"auth_mode" "auth_mode" NOT NULL,
	"external_subject" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"runtime_id" text NOT NULL,
	"runtime_profile" text NOT NULL,
	"allowed_tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"forbidden_surfaces" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_packet_id" uuid NOT NULL,
	"agent_profile_id" uuid NOT NULL,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"queue_job_id" text,
	"worktree_path" text,
	"branch_name" text,
	"artifact_root" text,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"agent_run_id" uuid,
	"action_category" "action_category" NOT NULL,
	"surface" text NOT NULL,
	"environment" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by_actor_id" uuid NOT NULL,
	"decided_by_actor_id" uuid,
	"decision_reason" text,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"redacted" boolean DEFAULT false NOT NULL,
	"retention_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_size_non_negative" CHECK ("artifacts"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"actor_id" uuid,
	"action_category" "action_category" NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"policy_decision" "policy_decision",
	"correlation_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "build_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_link_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"conclusion" text,
	"details_url" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canonical_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"incoming_event_id" uuid,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid,
	"deduplication_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid,
	"expected_version" integer,
	"result_version" integer,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"health" "risk_severity" NOT NULL,
	"metrics" jsonb NOT NULL,
	"source_event_id" uuid
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"environment" text NOT NULL,
	"revision" text NOT NULL,
	"status" text NOT NULL,
	"external_ref" text,
	"approved_by_actor_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incoming_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"action" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "event_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"failure_code" text
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"target_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"destination" text NOT NULL,
	"event_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pr_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_item_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"repository_ref" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"head_ref" text NOT NULL,
	"base_ref" text NOT NULL,
	"state" text NOT NULL,
	"draft" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_version_positive" CHECK ("projects"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "risk_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"agent_run_id" uuid,
	"code" text NOT NULL,
	"severity" "risk_severity" NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"queue_name" text NOT NULL,
	"status" "scheduled_job_status" DEFAULT 'active' NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"reference" text NOT NULL,
	"scope" text[] DEFAULT '{}'::text[] NOT NULL,
	"lease_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_item_id" uuid NOT NULL,
	"from_status" "work_item_status",
	"to_status" "work_item_status" NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"acceptance_criteria" text[] DEFAULT '{}'::text[] NOT NULL,
	"in_scope" text[] DEFAULT '{}'::text[] NOT NULL,
	"out_of_scope" text[] DEFAULT '{}'::text[] NOT NULL,
	"relevant_links" text[] DEFAULT '{}'::text[] NOT NULL,
	"relevant_files" text[] DEFAULT '{}'::text[] NOT NULL,
	"allowed_tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"forbidden_surfaces" text[] DEFAULT '{}'::text[] NOT NULL,
	"data_policy" jsonb NOT NULL,
	"timebox_minutes" integer NOT NULL,
	"expected_output_schema" jsonb NOT NULL,
	"reviewer_actor_id" uuid NOT NULL,
	"approver_actor_id" uuid NOT NULL,
	"runtime_profile" text NOT NULL,
	"auth_mode" "auth_mode" NOT NULL,
	"secret_ref_id" uuid,
	"created_from_event_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_packets_timebox_positive" CHECK ("task_packets"."timebox_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "tracker_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"surface" text NOT NULL,
	"external_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"external_version" text,
	"last_inbound_version" text,
	"last_outbound_mutation_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"milestone_id" uuid,
	"title" text NOT NULL,
	"summary" text,
	"status" "work_item_status" DEFAULT 'backlog' NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"owner_actor_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "work_items_version_positive" CHECK ("work_items"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requester_actor_id_actors_id_fk" FOREIGN KEY ("requester_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_decided_by_actor_id_actors_id_fk" FOREIGN KEY ("decided_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_packet_id_task_packets_id_fk" FOREIGN KEY ("task_packet_id") REFERENCES "public"."task_packets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_profile_id_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_actor_id_actors_id_fk" FOREIGN KEY ("requested_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_actor_id_actors_id_fk" FOREIGN KEY ("decided_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_checks" ADD CONSTRAINT "build_checks_pr_link_id_pr_links_id_fk" FOREIGN KEY ("pr_link_id") REFERENCES "public"."pr_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_events" ADD CONSTRAINT "canonical_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_events" ADD CONSTRAINT "canonical_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_events" ADD CONSTRAINT "canonical_events_incoming_event_id_incoming_events_id_fk" FOREIGN KEY ("incoming_event_id") REFERENCES "public"."incoming_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" ADD CONSTRAINT "dashboard_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" ADD CONSTRAINT "dashboard_snapshots_source_event_id_canonical_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."canonical_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_approved_by_actor_id_actors_id_fk" FOREIGN KEY ("approved_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_links" ADD CONSTRAINT "pr_links_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD CONSTRAINT "risk_signals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD CONSTRAINT "risk_signals_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_signals" ADD CONSTRAINT "risk_signals_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runbooks" ADD CONSTRAINT "runbooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_refs" ADD CONSTRAINT "secret_refs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_packets" ADD CONSTRAINT "task_packets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_packets" ADD CONSTRAINT "task_packets_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_packets" ADD CONSTRAINT "task_packets_reviewer_actor_id_actors_id_fk" FOREIGN KEY ("reviewer_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_packets" ADD CONSTRAINT "task_packets_approver_actor_id_actors_id_fk" FOREIGN KEY ("approver_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_packets" ADD CONSTRAINT "task_packets_secret_ref_id_secret_refs_id_fk" FOREIGN KEY ("secret_ref_id") REFERENCES "public"."secret_refs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_packets" ADD CONSTRAINT "task_packets_created_from_event_id_canonical_events_id_fk" FOREIGN KEY ("created_from_event_id") REFERENCES "public"."canonical_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_packets" ADD CONSTRAINT "task_packets_created_by_actor_id_actors_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_bindings" ADD CONSTRAINT "tracker_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_owner_actor_id_actors_id_fk" FOREIGN KEY ("owner_actor_id") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_requests_status_expiry_idx" ON "access_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "actors_external_subject_unique" ON "actors" USING btree ("workspace_id","auth_mode","external_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_actor_runtime_unique" ON "agent_profiles" USING btree ("actor_id","runtime_id","runtime_profile");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_idempotency_unique" ON "agent_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_runs_status_heartbeat_idx" ON "agent_runs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "approval_requests_status_expiry_idx" ON "approval_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_provider_key_unique" ON "artifacts" USING btree ("storage_provider","storage_key");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_created_idx" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "build_checks_provider_external_unique" ON "build_checks" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_events_deduplication_unique" ON "canonical_events" USING btree ("workspace_id","deduplication_key");--> statement-breakpoint
CREATE INDEX "canonical_events_aggregate_idx" ON "canonical_events" USING btree ("aggregate_type","aggregate_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "command_receipts_workspace_key_unique" ON "command_receipts" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_snapshots_project_captured_unique" ON "dashboard_snapshots" USING btree ("project_id","captured_at");--> statement-breakpoint
CREATE INDEX "deployments_project_environment_idx" ON "deployments" USING btree ("project_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_events_delivery_unique" ON "incoming_events" USING btree ("provider","delivery_id");--> statement-breakpoint
CREATE INDEX "incoming_events_status_received_idx" ON "incoming_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "milestones_project_idx" ON "milestones" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_idempotency_unique" ON "outbox_events" USING btree ("destination","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_events_status_available_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_links_provider_external_unique" ON "pr_links" USING btree ("provider","repository_ref","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_slug_unique" ON "projects" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "risk_signals_project_severity_idx" ON "risk_signals" USING btree ("project_id","severity","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runbooks_project_name_version_unique" ON "runbooks" USING btree ("project_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_jobs_project_name_unique" ON "scheduled_jobs" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_refs_workspace_reference_unique" ON "secret_refs" USING btree ("workspace_id","provider","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "status_transitions_idempotency_unique" ON "status_transitions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "status_transitions_work_item_idx" ON "status_transitions" USING btree ("work_item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_packets_content_hash_unique" ON "task_packets" USING btree ("work_item_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_bindings_external_unique" ON "tracker_bindings" USING btree ("provider","surface","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_bindings_entity_unique" ON "tracker_bindings" USING btree ("provider","surface","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "work_items_project_status_idx" ON "work_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_unique" ON "workspaces" USING btree ("slug");