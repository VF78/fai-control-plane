DROP INDEX "conversation_bindings_project_class_unique";--> statement-breakpoint
ALTER TABLE "conversation_bindings" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_bindings_project_class_unique" ON "conversation_bindings" USING btree ("project_id","conversation_class") WHERE "conversation_bindings"."active" = true;