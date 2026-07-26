CREATE TABLE "daily_pm_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"report_date" date NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_pm_reports" ADD CONSTRAINT "daily_pm_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_pm_reports_project_date_unique" ON "daily_pm_reports" USING btree ("project_id","report_date");
--> statement-breakpoint
CREATE FUNCTION daily_pm_reports_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'daily_pm_reports_are_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER daily_pm_reports_immutable
BEFORE UPDATE OR DELETE ON "daily_pm_reports"
FOR EACH ROW
EXECUTE FUNCTION daily_pm_reports_immutable();
