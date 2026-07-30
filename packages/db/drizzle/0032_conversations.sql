CREATE TYPE "public"."conversation_class" AS ENUM('internal', 'client');--> statement-breakpoint
CREATE TABLE "conversation_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_class" "conversation_class" NOT NULL,
	"provider" text NOT NULL,
	"external_ref" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_failure_code" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_bindings_provider_key" CHECK ("conversation_bindings"."provider" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "conversation_bindings_external_ref_bounded" CHECK (length("conversation_bindings"."external_ref") between 1 and 128),
	CONSTRAINT "conversation_bindings_failure_complete" CHECK (("conversation_bindings"."last_failure_at" is null and "conversation_bindings"."last_failure_code" is null)
        or ("conversation_bindings"."last_failure_at" is not null
          and length("conversation_bindings"."last_failure_code") between 1 and 64)),
	CONSTRAINT "conversation_bindings_failure_count_nonnegative" CHECK ("conversation_bindings"."failure_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"delivery_ref" text NOT NULL,
	"message_ref" text NOT NULL,
	"reply_to_message_ref" text,
	"thread_ref" text,
	"sent_at" timestamp with time zone NOT NULL,
	"text" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_delivery_ref_bounded" CHECK (length("conversation_messages"."delivery_ref") between 1 and 128),
	CONSTRAINT "conversation_messages_message_ref_bounded" CHECK (length("conversation_messages"."message_ref") between 1 and 128),
	CONSTRAINT "conversation_messages_reply_ref_bounded" CHECK ("conversation_messages"."reply_to_message_ref" is null or length("conversation_messages"."reply_to_message_ref") between 1 and 128),
	CONSTRAINT "conversation_messages_thread_ref_bounded" CHECK ("conversation_messages"."thread_ref" is null or length("conversation_messages"."thread_ref") between 1 and 128),
	CONSTRAINT "conversation_messages_text_bounded" CHECK ("conversation_messages"."text" is null or length("conversation_messages"."text") between 1 and 4000),
	CONSTRAINT "conversation_messages_attachments_array" CHECK (jsonb_typeof("conversation_messages"."attachments") = 'array'),
	CONSTRAINT "conversation_messages_has_content" CHECK ("conversation_messages"."text" is not null or jsonb_array_length("conversation_messages"."attachments") > 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"external_subject" text NOT NULL,
	"actor_id" uuid,
	"display_name" text NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_participants_subject_bounded" CHECK (length("conversation_participants"."external_subject") between 1 and 128),
	CONSTRAINT "conversation_participants_display_name_bounded" CHECK (length("conversation_participants"."display_name") between 1 and 120),
	CONSTRAINT "conversation_participants_observation_order" CHECK ("conversation_participants"."last_observed_at" >= "conversation_participants"."first_observed_at")
);
--> statement-breakpoint
ALTER TABLE "conversation_bindings" ADD CONSTRAINT "conversation_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_binding_id_conversation_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."conversation_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_participant_id_conversation_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."conversation_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_binding_id_conversation_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."conversation_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_bindings_project_class_unique" ON "conversation_bindings" USING btree ("project_id","conversation_class");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_bindings_provider_external_unique" ON "conversation_bindings" USING btree ("provider","external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_binding_delivery_unique" ON "conversation_messages" USING btree ("binding_id","delivery_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_binding_message_unique" ON "conversation_messages" USING btree ("binding_id","message_ref");--> statement-breakpoint
CREATE INDEX "conversation_messages_binding_sent_idx" ON "conversation_messages" USING btree ("binding_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participants_binding_subject_unique" ON "conversation_participants" USING btree ("binding_id","external_subject");--> statement-breakpoint
CREATE INDEX "conversation_participants_actor_idx" ON "conversation_participants" USING btree ("actor_id");