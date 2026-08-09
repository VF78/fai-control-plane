CREATE TYPE "public"."conversation_channel_state" AS ENUM('active', 'inactive', 'not_used');--> statement-breakpoint
CREATE TABLE "conversation_channel_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_class" "conversation_class" NOT NULL,
	"desired_state" "conversation_channel_state" NOT NULL,
	"provider" text,
	"configuration_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_channel_configurations_binding_complete" CHECK (("conversation_channel_configurations"."desired_state" = 'not_used' and "conversation_channel_configurations"."provider" is null and "conversation_channel_configurations"."configuration_ref" is null)
        or ("conversation_channel_configurations"."desired_state" in ('active', 'inactive')
          and "conversation_channel_configurations"."provider" ~ '^[a-z][a-z0-9_-]{0,63}$'
          and "conversation_channel_configurations"."configuration_ref" ~ '^[a-z][a-z0-9._:-]{0,127}$')),
	CONSTRAINT "conversation_channel_configurations_version_positive" CHECK ("conversation_channel_configurations"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "conversation_bindings" ADD COLUMN "configuration_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD COLUMN "observed_level" "access_level";--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD COLUMN "last_observation_ref" text;--> statement-breakpoint
ALTER TABLE "conversation_channel_configurations" ADD CONSTRAINT "conversation_channel_configurations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_channel_configurations_project_class_unique" ON "conversation_channel_configurations" USING btree ("project_id","conversation_class");--> statement-breakpoint
ALTER TABLE "conversation_bindings" ADD CONSTRAINT "conversation_bindings_configuration_id_conversation_channel_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."conversation_channel_configurations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_bindings_configuration_unique" ON "conversation_bindings" USING btree ("configuration_id") WHERE "conversation_bindings"."configuration_id" is not null;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_access_observation_complete" CHECK (("conversation_participants"."observed_level" is null and "conversation_participants"."observed_at" is null and "conversation_participants"."last_observation_ref" is null)
        or ("conversation_participants"."observed_level" is not null and "conversation_participants"."observed_at" is not null
          and length("conversation_participants"."last_observation_ref") between 1 and 128));