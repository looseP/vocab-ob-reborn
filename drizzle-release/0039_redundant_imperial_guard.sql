CREATE TABLE "l3_study_note_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_id" uuid,
	"question_id" uuid,
	"option_key" text,
	"start_offset" integer,
	"end_offset" integer,
	"quote_snapshot" text,
	"field_hash" text NOT NULL,
	"display_snapshot" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_study_note_references_kind_check" CHECK (kind = ANY (ARRAY['source'::text, 'source_quote'::text, 'question'::text, 'stem_quote'::text, 'option_quote'::text])),
	CONSTRAINT "l3_study_note_references_target_check" CHECK ((kind = ANY (ARRAY['source'::text, 'source_quote'::text]) AND source_id IS NOT NULL AND question_id IS NULL) OR (kind = ANY (ARRAY['question'::text, 'stem_quote'::text, 'option_quote'::text]) AND question_id IS NOT NULL AND source_id IS NULL)),
	CONSTRAINT "l3_study_note_references_quote_check" CHECK ((kind = ANY (ARRAY['source_quote'::text, 'stem_quote'::text, 'option_quote'::text]) AND start_offset IS NOT NULL AND end_offset IS NOT NULL AND quote_snapshot IS NOT NULL) OR (kind = ANY (ARRAY['source'::text, 'question'::text]) AND start_offset IS NULL AND end_offset IS NULL AND quote_snapshot IS NULL)),
	CONSTRAINT "l3_study_note_references_option_key_check" CHECK ((kind = 'option_quote'::text AND option_key IS NOT NULL) OR (kind <> 'option_quote'::text AND option_key IS NULL)),
	CONSTRAINT "l3_study_note_references_offset_check" CHECK (start_offset IS NULL OR (start_offset >= 0 AND end_offset > start_offset)),
	CONSTRAINT "l3_study_note_references_field_hash_check" CHECK (char_length(field_hash) = 64)
);
--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_study_note_venues" (
	"note_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"question_type" text NOT NULL,
	CONSTRAINT "l3_study_note_venues_pkey" PRIMARY KEY("note_id","question_type"),
	CONSTRAINT "l3_study_note_venues_type_check" CHECK (question_type = ANY (ARRAY['cloze'::text, 'reading_choice'::text, 'new_question'::text, 'sentence_translation'::text, 'short_essay'::text, 'long_essay'::text, 'grammar_blank'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_study_note_venues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_study_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"create_request_id" uuid NOT NULL,
	"create_input_hash" text NOT NULL,
	"last_write_request_id" uuid,
	"last_write_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_study_notes_user_create_request_unique" UNIQUE("user_id","create_request_id"),
	CONSTRAINT "l3_study_notes_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "l3_study_notes_status_check" CHECK (status = ANY (ARRAY['active'::text, 'archived'::text])),
	CONSTRAINT "l3_study_notes_version_check" CHECK (version >= 1),
	CONSTRAINT "l3_study_notes_title_check" CHECK (char_length(title) <= 120),
	CONSTRAINT "l3_study_notes_body_check" CHECK (char_length(body_md) <= 100000),
	CONSTRAINT "l3_study_notes_create_input_hash_check" CHECK (char_length(create_input_hash) = 64),
	CONSTRAINT "l3_study_notes_last_write_hash_check" CHECK (last_write_hash IS NULL OR char_length(last_write_hash) = 64)
);
--> statement-breakpoint
ALTER TABLE "l3_study_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_study_topic_notes" (
	"topic_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "l3_study_topic_notes_pkey" PRIMARY KEY("topic_id","note_id"),
	CONSTRAINT "l3_study_topic_notes_position_check" CHECK (position >= 0)
);
--> statement-breakpoint
ALTER TABLE "l3_study_topic_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_study_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_type" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"create_request_id" uuid NOT NULL,
	"create_input_hash" text NOT NULL,
	"last_write_request_id" uuid,
	"last_write_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_study_topics_user_create_request_unique" UNIQUE("user_id","create_request_id"),
	CONSTRAINT "l3_study_topics_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "l3_study_topics_status_check" CHECK (status = ANY (ARRAY['active'::text, 'archived'::text])),
	CONSTRAINT "l3_study_topics_version_check" CHECK (version >= 1),
	CONSTRAINT "l3_study_topics_title_check" CHECK (char_length(title) BETWEEN 1 AND 120),
	CONSTRAINT "l3_study_topics_type_check" CHECK (question_type = ANY (ARRAY['cloze'::text, 'reading_choice'::text, 'new_question'::text, 'sentence_translation'::text, 'short_essay'::text, 'long_essay'::text, 'grammar_blank'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_study_topics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD CONSTRAINT "l3_study_note_references_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD CONSTRAINT "l3_study_note_references_note_owner_fk" FOREIGN KEY ("note_id","user_id") REFERENCES "public"."l3_study_notes"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD CONSTRAINT "l3_study_note_references_source_owner_fk" FOREIGN KEY ("source_id","user_id") REFERENCES "public"."l3_sources"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD CONSTRAINT "l3_study_note_references_question_owner_fk" FOREIGN KEY ("question_id","user_id") REFERENCES "public"."l3_questions"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_study_note_venues" ADD CONSTRAINT "l3_study_note_venues_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_study_note_venues" ADD CONSTRAINT "l3_study_note_venues_note_owner_fk" FOREIGN KEY ("note_id","user_id") REFERENCES "public"."l3_study_notes"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_study_notes" ADD CONSTRAINT "l3_study_notes_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_study_topic_notes" ADD CONSTRAINT "l3_study_topic_notes_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_study_topic_notes" ADD CONSTRAINT "l3_study_topic_notes_topic_owner_fk" FOREIGN KEY ("topic_id","user_id") REFERENCES "public"."l3_study_topics"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_study_topic_notes" ADD CONSTRAINT "l3_study_topic_notes_note_owner_fk" FOREIGN KEY ("note_id","user_id") REFERENCES "public"."l3_study_notes"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_study_topics" ADD CONSTRAINT "l3_study_topics_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_l3_study_note_references_user_source" ON "l3_study_note_references" USING btree ("user_id","source_id","note_id");--> statement-breakpoint
CREATE INDEX "idx_l3_study_note_references_user_question" ON "l3_study_note_references" USING btree ("user_id","question_id","note_id");--> statement-breakpoint
CREATE INDEX "idx_l3_study_note_references_note" ON "l3_study_note_references" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "idx_l3_study_note_venues_user_type" ON "l3_study_note_venues" USING btree ("user_id","question_type","note_id");--> statement-breakpoint
CREATE INDEX "idx_l3_study_notes_user_status_updated" ON "l3_study_notes" USING btree ("user_id","status","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_l3_study_notes_title_trgm" ON "l3_study_notes" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_l3_study_notes_body_trgm" ON "l3_study_notes" USING gin ("body_md" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_l3_study_topic_notes_topic_position" ON "l3_study_topic_notes" USING btree ("topic_id","position","note_id");--> statement-breakpoint
CREATE INDEX "idx_l3_study_topic_notes_user_note" ON "l3_study_topic_notes" USING btree ("user_id","note_id");--> statement-breakpoint
CREATE INDEX "idx_l3_study_topics_user_type_status_updated" ON "l3_study_topics" USING btree ("user_id","question_type","status","updated_at","id");--> statement-breakpoint
CREATE POLICY "l3_study_note_references_own_all" ON "l3_study_note_references" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_study_note_venues_own_all" ON "l3_study_note_venues" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_study_notes_own_all" ON "l3_study_notes" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_study_topic_notes_own_all" ON "l3_study_topic_notes" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_study_topics_own_all" ON "l3_study_topics" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));