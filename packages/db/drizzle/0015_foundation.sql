CREATE TABLE "project_share_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_actor_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"field_scope" jsonb DEFAULT '["publicTitle","publicStatus","publicSummary","updatedTime"]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_actor_id" uuid,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_share_grants_token_hash_sha256" CHECK ("project_share_grants"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_share_grants_field_scope_fixed" CHECK ("project_share_grants"."field_scope" = '["publicTitle","publicStatus","publicSummary","updatedTime"]'::jsonb),
	CONSTRAINT "project_share_grants_expiry_after_creation" CHECK ("project_share_grants"."expires_at" > "project_share_grants"."created_at"),
	CONSTRAINT "project_share_grants_revocation_consistent" CHECK (("project_share_grants"."revoked_at" is null and "project_share_grants"."revoked_by_actor_id" is null)
        or ("project_share_grants"."revoked_at" is not null and "project_share_grants"."revoked_by_actor_id" is not null
          and "project_share_grants"."revoked_at" >= "project_share_grants"."created_at")),
	CONSTRAINT "project_share_grants_access_consistent" CHECK (("project_share_grants"."access_count" = 0 and "project_share_grants"."last_accessed_at" is null)
        or ("project_share_grants"."access_count" > 0 and "project_share_grants"."last_accessed_at" is not null
          and "project_share_grants"."last_accessed_at" >= "project_share_grants"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "project_share_work_items" (
	"grant_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	CONSTRAINT "project_share_work_items_pk" PRIMARY KEY("grant_id","work_item_id")
);
--> statement-breakpoint
ALTER TABLE "project_share_grants" ADD CONSTRAINT "project_share_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_grants" ADD CONSTRAINT "project_share_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_grants" ADD CONSTRAINT "project_share_grants_created_by_actor_id_actors_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_grants" ADD CONSTRAINT "project_share_grants_revoked_by_actor_id_actors_id_fk" FOREIGN KEY ("revoked_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_work_items" ADD CONSTRAINT "project_share_work_items_grant_id_project_share_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."project_share_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_work_items" ADD CONSTRAINT "project_share_work_items_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_share_grants_token_hash_unique" ON "project_share_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "project_share_grants_project_idx" ON "project_share_grants" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_share_grants_expires_idx" ON "project_share_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "project_share_work_items_work_item_idx" ON "project_share_work_items" USING btree ("work_item_id");