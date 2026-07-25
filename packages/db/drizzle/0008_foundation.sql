CREATE TABLE "project_tracker_repository_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"repository_external_id" text NOT NULL,
	"credential_ref_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_tracker_repository_scopes" ADD CONSTRAINT "project_tracker_repository_scopes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tracker_repository_scopes" ADD CONSTRAINT "project_tracker_repository_scopes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tracker_repository_scopes" ADD CONSTRAINT "project_tracker_repository_scopes_credential_ref_id_secret_refs_id_fk" FOREIGN KEY ("credential_ref_id") REFERENCES "public"."secret_refs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_tracker_repository_scopes_config_unique" ON "project_tracker_repository_scopes" USING btree ("project_id","provider","repository_owner","repository_name");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tracker_repository_scopes_external_unique" ON "project_tracker_repository_scopes" USING btree ("project_id","provider","repository_external_id");
--> statement-breakpoint
CREATE FUNCTION project_tracker_repository_scope_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.project_id IS DISTINCT FROM OLD.project_id OR
     NEW.provider IS DISTINCT FROM OLD.provider OR
     NEW.repository_owner IS DISTINCT FROM OLD.repository_owner OR
     NEW.repository_name IS DISTINCT FROM OLD.repository_name OR
     NEW.repository_external_id IS DISTINCT FROM OLD.repository_external_id OR
     NEW.credential_ref_id IS DISTINCT FROM OLD.credential_ref_id THEN
    RAISE EXCEPTION 'project_tracker_repository_scope_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_tracker_repository_scope_identity_immutable
BEFORE UPDATE ON "project_tracker_repository_scopes"
FOR EACH ROW
EXECUTE FUNCTION project_tracker_repository_scope_identity_immutable();
