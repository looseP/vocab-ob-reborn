CREATE TABLE "l3_context_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"context_id" uuid,
	"word_id" uuid,
	"link_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"target_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" numeric(5, 4),
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_context_links_link_type_check" CHECK (link_type = ANY (ARRAY['supports'::text, 'illustrates'::text, 'contrasts'::text, 'collocates_with'::text, 'synonym_of'::text, 'antonym_of'::text, 'derived_from'::text, 'topic_related'::text, 'manual_link'::text])),
	CONSTRAINT "l3_context_links_target_type_check" CHECK (target_type = ANY (ARRAY['word'::text, 'l2_item'::text, 'context'::text, 'source'::text, 'topic'::text, 'external'::text])),
	CONSTRAINT "l3_context_links_confidence_check" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);
--> statement-breakpoint
ALTER TABLE "l3_context_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"context_type" text NOT NULL,
	"text" text NOT NULL,
	"normalized_text" text,
	"language" text,
	"position" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_contexts_context_type_check" CHECK (context_type = ANY (ARRAY['sentence'::text, 'paragraph'::text, 'excerpt'::text, 'dialogue'::text, 'note'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_contexts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" uuid,
	"status" text NOT NULL,
	"input_hash" text NOT NULL,
	"input_summary" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_import_jobs_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_import_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"lemma" text,
	"start_offset" integer,
	"end_offset" integer,
	"confidence" numeric(5, 4),
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_occurrences_offset_check" CHECK ((start_offset IS NULL AND end_offset IS NULL) OR (start_offset IS NOT NULL AND end_offset IS NOT NULL AND start_offset >= 0 AND end_offset >= start_offset)),
	CONSTRAINT "l3_occurrences_confidence_check" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);
--> statement-breakpoint
ALTER TABLE "l3_occurrences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wordbook_id" uuid,
	"source_type" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"url" text,
	"language" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_sources_source_type_check" CHECK (source_type = ANY (ARRAY['article'::text, 'book'::text, 'video'::text, 'audio'::text, 'chat'::text, 'manual'::text, 'web'::text, 'other'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "l3_context_links" ADD CONSTRAINT "l3_context_links_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_context_links" ADD CONSTRAINT "l3_context_links_context_id_l3_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."l3_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_context_links" ADD CONSTRAINT "l3_context_links_word_id_words_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_contexts" ADD CONSTRAINT "l3_contexts_source_id_l3_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."l3_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_contexts" ADD CONSTRAINT "l3_contexts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_import_jobs" ADD CONSTRAINT "l3_import_jobs_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_import_jobs" ADD CONSTRAINT "l3_import_jobs_source_id_l3_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."l3_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_occurrences" ADD CONSTRAINT "l3_occurrences_context_id_l3_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."l3_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_occurrences" ADD CONSTRAINT "l3_occurrences_word_id_words_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_occurrences" ADD CONSTRAINT "l3_occurrences_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_sources" ADD CONSTRAINT "l3_sources_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_sources" ADD CONSTRAINT "l3_sources_wordbook_id_wordbooks_id_fk" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_l3_context_links_word_type" ON "l3_context_links" USING btree ("word_id","link_type");--> statement-breakpoint
CREATE INDEX "idx_l3_context_links_context_type" ON "l3_context_links" USING btree ("context_id","link_type");--> statement-breakpoint
CREATE INDEX "idx_l3_contexts_source_created" ON "l3_contexts" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_l3_import_jobs_user_status" ON "l3_import_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_l3_occurrences_word_created" ON "l3_occurrences" USING btree ("word_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_l3_occurrences_context" ON "l3_occurrences" USING btree ("context_id");--> statement-breakpoint
CREATE INDEX "idx_l3_sources_user_created" ON "l3_sources" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE POLICY "l3_context_links_own_all" ON "l3_context_links" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_contexts_own_all" ON "l3_contexts" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_import_jobs_own_all" ON "l3_import_jobs" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_occurrences_own_all" ON "l3_occurrences" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_sources_own_all" ON "l3_sources" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));