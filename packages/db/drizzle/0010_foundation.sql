CREATE TABLE "oauth_login_attempts" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_login_attempts_state_hash_sha256" CHECK ("oauth_login_attempts"."state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_login_attempts_expiry_after_creation" CHECK ("oauth_login_attempts"."expires_at" > "oauth_login_attempts"."created_at")
);
--> statement-breakpoint
CREATE TABLE "operator_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"github_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_sessions_token_hash_sha256" CHECK ("operator_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "operator_sessions_github_user_id_positive" CHECK ("operator_sessions"."github_user_id" > 0),
	CONSTRAINT "operator_sessions_expiry_after_creation" CHECK ("operator_sessions"."expires_at" > "operator_sessions"."created_at"),
	CONSTRAINT "operator_sessions_last_seen_after_creation" CHECK ("operator_sessions"."last_seen_at" >= "operator_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_login_attempts_expires_idx" ON "oauth_login_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "operator_sessions_actor_idx" ON "operator_sessions" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "operator_sessions_expires_idx" ON "operator_sessions" USING btree ("expires_at");