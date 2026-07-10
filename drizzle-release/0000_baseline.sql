CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS auth;--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;--> statement-breakpoint
CREATE TYPE "public"."review_rating" AS ENUM('again', 'hard', 'good', 'easy');--> statement-breakpoint
CREATE TABLE "collection_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"content_hash" text NOT NULL,
	"source_path" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body_md" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{""}' NOT NULL,
	"related_word_slugs" text[] DEFAULT '{""}' NOT NULL,
	"source_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_published" boolean DEFAULT true NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_notes_slug_key" UNIQUE("slug"),
	CONSTRAINT "collection_notes_content_hash_key" UNIQUE("content_hash"),
	CONSTRAINT "collection_notes_source_path_key" UNIQUE("source_path"),
	CONSTRAINT "collection_notes_content_hash_check" CHECK (content_hash ~ '^[0-9a-f]{64}$'::text),
	CONSTRAINT "collection_notes_kind_check" CHECK (kind = ANY (ARRAY['root_affix'::text, 'semantic_field'::text]))
);
--> statement-breakpoint
ALTER TABLE "collection_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "daily_forecast_snapshots" (
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"forecast_count" integer NOT NULL,
	"desired_retention" numeric NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_forecast_snapshots_pkey" PRIMARY KEY("user_id","date"),
	CONSTRAINT "daily_forecast_snapshots_forecast_count_check" CHECK (forecast_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "daily_forecast_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"source_path" text,
	"error_stage" text NOT NULL,
	"error_message" text NOT NULL,
	"raw_excerpt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_errors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"trigger_type" text NOT NULL,
	"repo_owner" text,
	"repo_name" text,
	"repo_branch" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"soft_deleted_count" integer DEFAULT 0 NOT NULL,
	"tags_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_runs_status_check" CHECK (status = ANY (ARRAY['running'::text, 'completed'::text, 'completed_with_errors'::text, 'failed'::text]))
);
--> statement-breakpoint
ALTER TABLE "import_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
	CONSTRAINT "l3_contexts_id_user_id_unique" UNIQUE("id","user_id"),
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
CREATE TABLE "l3_proposal_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"ordinal" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"validation_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_entity_type" text,
	"active_entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_proposal_items_proposal_ordinal_unique" UNIQUE("proposal_id","ordinal"),
	CONSTRAINT "l3_proposal_items_item_type_check" CHECK (item_type = ANY (ARRAY['source'::text, 'context'::text, 'occurrence'::text, 'context_link'::text])),
	CONSTRAINT "l3_proposal_items_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'rejected'::text])),
	CONSTRAINT "l3_proposal_items_active_entity_type_check" CHECK (active_entity_type IS NULL OR active_entity_type = ANY (ARRAY['source'::text, 'context'::text, 'occurrence'::text, 'context_link'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_proposal_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wordbook_id" uuid,
	"source_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text,
	"summary" text,
	"input_hash" text,
	"proposed_by" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"review_note" text,
	"confirmed_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_proposals_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "l3_proposals_source_type_check" CHECK (source_type = ANY (ARRAY['agent'::text, 'import'::text, 'external_tool'::text, 'manual_draft'::text, 'mcp_future'::text, 'other'::text])),
	CONSTRAINT "l3_proposals_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'rejected'::text, 'canceled'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_recommendation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"wordbook_id" uuid,
	"recommendation_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"priority_score" numeric(8, 4) NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accepted_proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "l3_recommendation_items_type_check" CHECK (recommendation_type = ANY (ARRAY['review_pack'::text, 'learn_next'::text, 'link_gap'::text, 'context_gap'::text, 'l2_gap'::text, 'weak_word'::text, 'related_word'::text])),
	CONSTRAINT "l3_recommendation_items_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'dismissed'::text, 'expired'::text])),
	CONSTRAINT "l3_recommendation_items_priority_check" CHECK (priority_score >= 0),
	CONSTRAINT "l3_recommendation_items_confidence_check" CHECK (confidence >= 0 AND confidence <= 1)
);
--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_recommendation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wordbook_id" uuid,
	"mode" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"input_hash" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "l3_recommendation_runs_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "l3_recommendation_runs_mode_check" CHECK (mode = ANY (ARRAY['review_pack'::text, 'learn_next'::text, 'gap_scan'::text, 'link_suggestions'::text])),
	CONSTRAINT "l3_recommendation_runs_status_check" CHECK (status = ANY (ARRAY['completed'::text, 'failed'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_recommendation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
	CONSTRAINT "l3_sources_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "l3_sources_source_type_check" CHECK (source_type = ANY (ARRAY['article'::text, 'book'::text, 'video'::text, 'audio'::text, 'chat'::text, 'manual'::text, 'web'::text, 'other'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_md" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wordbook_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"content_md" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wordbook_id" uuid NOT NULL,
	CONSTRAINT "notes_user_wordbook_word_key" UNIQUE("user_id","word_id","wordbook_id")
);
--> statement-breakpoint
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"display_name" text,
	"avatar_url" text,
	"role" text DEFAULT 'user' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_email_key" UNIQUE("email"),
	CONSTRAINT "profiles_role_check" CHECK (role = ANY (ARRAY['user'::text, 'editor'::text, 'admin'::text]))
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "review_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"session_id" uuid,
	"rating" "review_rating",
	"state" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"elapsed_days" integer,
	"scheduled_days" integer,
	"stability" numeric(10, 4),
	"difficulty" numeric(10, 4),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previous_progress_snapshot" jsonb,
	"undone" boolean DEFAULT false NOT NULL,
	"undone_at" timestamp with time zone,
	"progress_id" uuid,
	"wordbook_id" uuid NOT NULL,
	"idempotency_key" text,
	"track" text DEFAULT 'l1' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "review_logs_archive" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"word_id" uuid,
	"progress_id" uuid,
	"rating" text,
	"state" text,
	"reviewed_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"elapsed_days" integer,
	"scheduled_days" integer,
	"stability" numeric,
	"difficulty" numeric,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wordbook_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" text DEFAULT 'review' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"cards_seen" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"wordbook_id" uuid NOT NULL,
	CONSTRAINT "sessions_mode_check" CHECK (mode = ANY (ARRAY['review'::text, 'cram'::text, 'preview'::text]))
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_slug_key" UNIQUE("slug"),
	CONSTRAINT "tags_label_key" UNIQUE("label")
);
--> statement-breakpoint
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_word_l2_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"wordbook_id" uuid NOT NULL,
	"l2_stability" numeric(10, 4),
	"l2_difficulty" numeric(10, 4),
	"l2_retrievability" numeric(8, 6),
	"l2_state" text DEFAULT 'review' NOT NULL,
	"l2_desired_retention" numeric(4, 3) DEFAULT '0.900' NOT NULL,
	"l2_due_at" timestamp with time zone,
	"l2_last_reviewed_at" timestamp with time zone,
	"l2_last_rating" text,
	"l2_review_count" integer DEFAULT 0 NOT NULL,
	"l2_lapse_count" integer DEFAULT 0 NOT NULL,
	"l2_interval_days" integer,
	"l2_scheduler_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"l2_again_count" integer DEFAULT 0 NOT NULL,
	"l2_hard_count" integer DEFAULT 0 NOT NULL,
	"l2_good_count" integer DEFAULT 0 NOT NULL,
	"l2_easy_count" integer DEFAULT 0 NOT NULL,
	"l2_content_hash_snapshot" text,
	"recent_ratings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"l2_paused" boolean DEFAULT false NOT NULL,
	"l2_paused_at" timestamp with time zone,
	"l2_paused_reason" text,
	"l2_inherited_from_l1" boolean DEFAULT false,
	"l2_weights_source" text DEFAULT 'inherited',
	"l2_predicted_retrievability" numeric(8, 6),
	"l3_pending" boolean DEFAULT false,
	"l3_self_assessments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l2_state_check" CHECK (l2_state = ANY (ARRAY['new'::text, 'learning'::text, 'review'::text, 'relearning'::text, 'suspended'::text])),
	CONSTRAINT "l2_retention_check" CHECK (l2_desired_retention >= 0.900 AND l2_desired_retention <= 0.990),
	CONSTRAINT "l2_paused_reason_check" CHECK (l2_paused_reason IS NULL OR l2_paused_reason = ANY (ARRAY['l1_cascade_failure'::text, 'wordbook_focus'::text, 'manual'::text]))
);
--> statement-breakpoint
CREATE TABLE "user_word_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"schedule_algo" text DEFAULT 'fsrs' NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"desired_retention" numeric(4, 3) DEFAULT '0.900' NOT NULL,
	"stability" numeric(10, 4),
	"difficulty" numeric(10, 4),
	"retrievability" numeric(8, 6),
	"interval_days" integer,
	"due_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"last_rating" "review_rating",
	"review_count" integer DEFAULT 0 NOT NULL,
	"lapse_count" integer DEFAULT 0 NOT NULL,
	"again_count" integer DEFAULT 0 NOT NULL,
	"hard_count" integer DEFAULT 0 NOT NULL,
	"good_count" integer DEFAULT 0 NOT NULL,
	"easy_count" integer DEFAULT 0 NOT NULL,
	"content_hash_snapshot" text,
	"l1_content_hash_snapshot" text,
	"recent_ratings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"l1_weak_signal" boolean DEFAULT false NOT NULL,
	"scheduler_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"skip_count" integer DEFAULT 0 NOT NULL,
	"wordbook_id" uuid NOT NULL,
	"needs_recheck" boolean DEFAULT false NOT NULL,
	CONSTRAINT "user_word_progress_user_wordbook_word_key" UNIQUE("user_id","word_id","wordbook_id"),
	CONSTRAINT "user_word_progress_schedule_algo_check" CHECK (schedule_algo = ANY (ARRAY['leitner'::text, 'sm2'::text, 'fsrs'::text])),
	CONSTRAINT "user_word_progress_state_check" CHECK (state = ANY (ARRAY['new'::text, 'learning'::text, 'review'::text, 'relearning'::text, 'suspended'::text])),
	CONSTRAINT "user_word_progress_desired_retention_check" CHECK ((desired_retention >= 0.700) AND (desired_retention <= 0.990))
);
--> statement-breakpoint
ALTER TABLE "user_word_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"email_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "word_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"wordbook_id" uuid NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "word_filter_facets" (
	"dimension" text NOT NULL,
	"value" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "word_filter_facets_pkey" PRIMARY KEY("dimension","value"),
	CONSTRAINT "word_filter_facets_dimension_check" CHECK (dimension = ANY (ARRAY['semantic_field'::text, 'word_freq'::text])),
	CONSTRAINT "word_filter_facets_count_check" CHECK (count >= 0)
);
--> statement-breakpoint
ALTER TABLE "word_filter_facets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "word_highlights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"wordbook_id" uuid NOT NULL,
	"source_field" text DEFAULT 'definition_md' NOT NULL,
	"text_snippet" text NOT NULL,
	"color" text DEFAULT '#eab308' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "word_l2_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"word_id" uuid NOT NULL,
	"field" text NOT NULL,
	"content" jsonb NOT NULL,
	"source" text NOT NULL,
	"source_ref" uuid,
	"approved_by" text DEFAULT 'user',
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "word_tags" (
	"word_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "word_tags_pkey" PRIMARY KEY("word_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "word_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wordbook_items" (
	"wordbook_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wordbook_items_pkey" PRIMARY KEY("wordbook_id","word_id")
);
--> statement-breakpoint
ALTER TABLE "wordbook_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wordbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settings" jsonb,
	CONSTRAINT "wordbooks_id_user_id_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "wordbooks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "words" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"content_hash" text NOT NULL,
	"l1_content_hash" text,
	"l2_content_hash" text,
	"source_path" text NOT NULL,
	"title" text NOT NULL,
	"lemma" text NOT NULL,
	"lang_code" text DEFAULT 'en' NOT NULL,
	"pos" text,
	"cefr" text,
	"ipa" text,
	"aliases" text[] DEFAULT '{""}' NOT NULL,
	"short_definition" text,
	"definition_md" text NOT NULL,
	"body_md" text NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_published" boolean DEFAULT true NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"core_definitions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prototype_text" text,
	"collocations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"corpus_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synonym_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"antonym_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body_html" text,
	"definition_html" text,
	"synonym_html" text,
	"antonym_html" text,
	"quality_status" text DEFAULT 'ok' NOT NULL,
	"quality_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((((((((((COALESCE(lemma, ''::text) || ' '::text) || COALESCE(title, ''::text)) || ' '::text) || COALESCE(short_definition, ''::text)) || ' '::text) || COALESCE(definition_md, ''::text)) || ' '::text) || COALESCE((metadata ->> 'semantic_field'::text), ''::text)) || ' '::text) || COALESCE((metadata ->> 'word_freq'::text), ''::text)))) STORED,
	CONSTRAINT "words_slug_key" UNIQUE("slug"),
	CONSTRAINT "words_content_hash_key" UNIQUE("content_hash"),
	CONSTRAINT "words_content_hash_check" CHECK (content_hash ~ '^[0-9a-f]{64}$'::text),
	CONSTRAINT "words_quality_status_check" CHECK (quality_status = ANY (ARRAY['ok'::text, 'needs_supplement'::text, 'rejected'::text]))
);
--> statement-breakpoint
ALTER TABLE "words" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "daily_forecast_snapshots" ADD CONSTRAINT "daily_forecast_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_errors" ADD CONSTRAINT "import_errors_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_context_links" ADD CONSTRAINT "l3_context_links_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_context_links" ADD CONSTRAINT "l3_context_links_context_id_l3_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."l3_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_context_links" ADD CONSTRAINT "l3_context_links_word_id_words_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_context_links" ADD CONSTRAINT "l3_context_links_context_owner_fk" FOREIGN KEY ("context_id","user_id") REFERENCES "public"."l3_contexts"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_contexts" ADD CONSTRAINT "l3_contexts_source_id_l3_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."l3_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_contexts" ADD CONSTRAINT "l3_contexts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_contexts" ADD CONSTRAINT "l3_contexts_source_owner_fk" FOREIGN KEY ("source_id","user_id") REFERENCES "public"."l3_sources"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_import_jobs" ADD CONSTRAINT "l3_import_jobs_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_import_jobs" ADD CONSTRAINT "l3_import_jobs_source_id_l3_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."l3_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_occurrences" ADD CONSTRAINT "l3_occurrences_context_id_l3_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."l3_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_occurrences" ADD CONSTRAINT "l3_occurrences_word_id_words_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_occurrences" ADD CONSTRAINT "l3_occurrences_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_occurrences" ADD CONSTRAINT "l3_occurrences_context_owner_fk" FOREIGN KEY ("context_id","user_id") REFERENCES "public"."l3_contexts"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_proposal_items" ADD CONSTRAINT "l3_proposal_items_proposal_id_l3_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."l3_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_proposal_items" ADD CONSTRAINT "l3_proposal_items_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_proposal_items" ADD CONSTRAINT "l3_proposal_items_proposal_owner_fk" FOREIGN KEY ("proposal_id","user_id") REFERENCES "public"."l3_proposals"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_proposals" ADD CONSTRAINT "l3_proposals_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_proposals" ADD CONSTRAINT "l3_proposals_wordbook_owner_fk" FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ADD CONSTRAINT "l3_recommendation_items_run_id_l3_recommendation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."l3_recommendation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ADD CONSTRAINT "l3_recommendation_items_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ADD CONSTRAINT "l3_recommendation_items_run_owner_fk" FOREIGN KEY ("run_id","user_id") REFERENCES "public"."l3_recommendation_runs"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ADD CONSTRAINT "l3_recommendation_items_wordbook_owner_fk" FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ADD CONSTRAINT "l3_recommendation_items_proposal_owner_fk" FOREIGN KEY ("accepted_proposal_id","user_id") REFERENCES "public"."l3_proposals"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_runs" ADD CONSTRAINT "l3_recommendation_runs_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_runs" ADD CONSTRAINT "l3_recommendation_runs_wordbook_owner_fk" FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_sources" ADD CONSTRAINT "l3_sources_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_sources" ADD CONSTRAINT "l3_sources_wordbook_owner_fk" FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_revisions" ADD CONSTRAINT "fk_note_revisions_wordbook" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "fk_notes_wordbook" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_progress_id_fkey" FOREIGN KEY ("progress_id") REFERENCES "public"."user_word_progress"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "fk_review_logs_wordbook" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs_archive" ADD CONSTRAINT "fk_review_logs_archive_wordbook" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "fk_sessions_wordbook" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_word_l2_progress" ADD CONSTRAINT "user_word_l2_progress_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_word_l2_progress" ADD CONSTRAINT "user_word_l2_progress_word_id_words_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_word_l2_progress" ADD CONSTRAINT "user_word_l2_progress_wordbook_id_wordbooks_id_fk" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_word_progress" ADD CONSTRAINT "user_word_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_word_progress" ADD CONSTRAINT "user_word_progress_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_word_progress" ADD CONSTRAINT "fk_uwp_wordbook" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_annotations" ADD CONSTRAINT "word_annotations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_annotations" ADD CONSTRAINT "word_annotations_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_annotations" ADD CONSTRAINT "word_annotations_wordbook_id_fkey" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_highlights" ADD CONSTRAINT "word_highlights_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_highlights" ADD CONSTRAINT "word_highlights_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_highlights" ADD CONSTRAINT "word_highlights_wordbook_id_fkey" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_l2_content" ADD CONSTRAINT "word_l2_content_word_id_words_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_tags" ADD CONSTRAINT "word_tags_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_tags" ADD CONSTRAINT "word_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wordbook_items" ADD CONSTRAINT "wordbook_items_wordbook_id_fkey" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wordbook_items" ADD CONSTRAINT "wordbook_items_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wordbooks" ADD CONSTRAINT "wordbooks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_collection_notes_kind_published" ON "collection_notes" USING btree ("kind","is_published","is_deleted");--> statement-breakpoint
CREATE INDEX "idx_collection_notes_source_path" ON "collection_notes" USING btree ("source_path");--> statement-breakpoint
CREATE INDEX "idx_daily_forecast_snapshots_user_date" ON "daily_forecast_snapshots" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "idx_import_errors_run_id" ON "import_errors" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_import_runs_started_at" ON "import_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_import_runs_status" ON "import_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "idx_l3_context_links_word_type" ON "l3_context_links" USING btree ("word_id","link_type");--> statement-breakpoint
CREATE INDEX "idx_l3_context_links_context_type" ON "l3_context_links" USING btree ("context_id","link_type");--> statement-breakpoint
CREATE INDEX "idx_l3_contexts_source_created" ON "l3_contexts" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_l3_import_jobs_user_status" ON "l3_import_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_l3_occurrences_word_created" ON "l3_occurrences" USING btree ("word_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_l3_occurrences_context" ON "l3_occurrences" USING btree ("context_id");--> statement-breakpoint
CREATE INDEX "idx_l3_proposal_items_proposal_ordinal" ON "l3_proposal_items" USING btree ("proposal_id","ordinal");--> statement-breakpoint
CREATE INDEX "idx_l3_proposal_items_user_status" ON "l3_proposal_items" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_l3_proposals_user_status_created" ON "l3_proposals" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_l3_recommendation_items_user_status_created" ON "l3_recommendation_items" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_l3_recommendation_items_run" ON "l3_recommendation_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_l3_recommendation_runs_user_created" ON "l3_recommendation_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_l3_sources_user_created" ON "l3_sources" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_created" ON "llm_usage" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_note_revisions_note_version" ON "note_revisions" USING btree ("note_id","version");--> statement-breakpoint
CREATE INDEX "idx_note_revisions_note_id" ON "note_revisions" USING btree ("note_id","version");--> statement-breakpoint
CREATE INDEX "idx_note_revisions_user_word" ON "note_revisions" USING btree ("user_id","word_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notes_wordbook" ON "notes" USING btree ("wordbook_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_review_logs_idempotency" ON "review_logs" USING btree ("user_id","idempotency_key") WHERE (idempotency_key IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_review_logs_progress_undone" ON "review_logs" USING btree ("progress_id","reviewed_at") WHERE (undone = false);--> statement-breakpoint
CREATE INDEX "idx_review_logs_progress_undone_count" ON "review_logs" USING btree ("progress_id") WHERE ((undone = false) AND (progress_id IS NOT NULL));--> statement-breakpoint
CREATE INDEX "idx_review_logs_user_reviewed" ON "review_logs" USING btree ("user_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "idx_review_logs_user_track_reviewed" ON "review_logs" USING btree ("user_id","track","reviewed_at");--> statement-breakpoint
CREATE INDEX "idx_review_logs_user_undone_reviewed" ON "review_logs" USING btree ("user_id","undone","reviewed_at");--> statement-breakpoint
CREATE INDEX "idx_review_logs_word" ON "review_logs" USING btree ("word_id");--> statement-breakpoint
CREATE INDEX "idx_review_logs_wordbook" ON "review_logs" USING btree ("wordbook_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "idx_review_logs_archive_user_reviewed" ON "review_logs_archive" USING btree ("user_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "idx_review_logs_archive_wordbook" ON "review_logs_archive" USING btree ("wordbook_id","reviewed_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_user_mode_active" ON "sessions" USING btree ("user_id","mode","ended_at","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sessions_one_active" ON "sessions" USING btree ("user_id","wordbook_id","mode") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_sessions_wordbook" ON "sessions" USING btree ("wordbook_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_l2_progress_user_wordbook_word" ON "user_word_l2_progress" USING btree ("user_id","wordbook_id","word_id");--> statement-breakpoint
CREATE INDEX "idx_l2_progress_wordbook_due" ON "user_word_l2_progress" USING btree ("wordbook_id","user_id","l2_due_at") WHERE (l2_paused = false);--> statement-breakpoint
CREATE INDEX "idx_l2_progress_word" ON "user_word_l2_progress" USING btree ("word_id");--> statement-breakpoint
CREATE INDEX "idx_progress_due" ON "user_word_progress" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "idx_progress_recheck" ON "user_word_progress" USING btree ("user_id","wordbook_id") WHERE (needs_recheck = true);--> statement-breakpoint
CREATE INDEX "idx_progress_word" ON "user_word_progress" USING btree ("word_id");--> statement-breakpoint
CREATE INDEX "idx_user_word_progress_due" ON "user_word_progress" USING btree ("user_id","wordbook_id","state","due_at");--> statement-breakpoint
CREATE INDEX "idx_uwp_has_hash_snapshot" ON "user_word_progress" USING btree ("word_id") WHERE (content_hash_snapshot IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_uwp_wordbook_due" ON "user_word_progress" USING btree ("wordbook_id","due_at");--> statement-breakpoint
CREATE INDEX "idx_word_annotations_lookup" ON "word_annotations" USING btree ("user_id","wordbook_id","word_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_word_annotations_unique" ON "word_annotations" USING btree ("user_id","wordbook_id","word_id");--> statement-breakpoint
CREATE INDEX "idx_word_highlights_lookup" ON "word_highlights" USING btree ("user_id","wordbook_id","word_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_word_highlights_unique_snippet" ON "word_highlights" USING btree ("user_id","wordbook_id","word_id","source_field","text_snippet");--> statement-breakpoint
CREATE INDEX "idx_l2_content_word_field" ON "word_l2_content" USING btree ("word_id","field");--> statement-breakpoint
CREATE INDEX "idx_l2_content_source" ON "word_l2_content" USING btree ("source");--> statement-breakpoint
CREATE INDEX "idx_wordbook_items_word_id" ON "wordbook_items" USING btree ("word_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wordbooks_user_default" ON "wordbooks" USING btree ("user_id","is_default") WHERE (is_default = true);--> statement-breakpoint
CREATE INDEX "idx_wordbooks_user_id" ON "wordbooks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_words_aliases_gin" ON "words" USING gin ("aliases" array_ops);--> statement-breakpoint
CREATE INDEX "idx_words_lemma_trgm" ON "words" USING gin ("lemma" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_words_metadata_gin" ON "words" USING gin ("metadata" jsonb_ops);--> statement-breakpoint
CREATE INDEX "idx_words_public_lemma_sort" ON "words" USING btree ("lemma") WHERE ((is_published = true) AND (is_deleted = false));--> statement-breakpoint
CREATE INDEX "idx_words_public_metadata_filter" ON "words" USING gin ("metadata" jsonb_path_ops) WHERE ((is_published = true) AND (is_deleted = false));--> statement-breakpoint
CREATE INDEX "idx_words_published" ON "words" USING btree ("is_published","is_deleted");--> statement-breakpoint
CREATE INDEX "idx_words_quality_status" ON "words" USING btree ("quality_status") WHERE (quality_status <> 'ok'::text);--> statement-breakpoint
CREATE INDEX "idx_words_search" ON "words" USING gin ("search_vector" tsvector_ops);--> statement-breakpoint
CREATE INDEX "idx_words_source_path" ON "words" USING btree ("source_path");--> statement-breakpoint
CREATE INDEX "idx_words_title_trgm" ON "words" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE POLICY "collection_notes_public_read" ON "collection_notes" AS PERMISSIVE FOR SELECT TO public USING (((is_published = true) AND (is_deleted = false)));--> statement-breakpoint
CREATE POLICY "daily_forecast_snapshots_own_all" ON "daily_forecast_snapshots" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "import_errors_no_public_access" ON "import_errors" AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "import_runs_no_public_access" ON "import_runs" AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "l3_context_links_own_all" ON "l3_context_links" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_contexts_own_all" ON "l3_contexts" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_import_jobs_own_all" ON "l3_import_jobs" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_occurrences_own_all" ON "l3_occurrences" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_proposal_items_own_all" ON "l3_proposal_items" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_proposals_own_all" ON "l3_proposals" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_recommendation_items_own_all" ON "l3_recommendation_items" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_recommendation_runs_own_all" ON "l3_recommendation_runs" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_sources_own_all" ON "l3_sources" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "note_revisions_own_all" ON "note_revisions" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "notes_own_all" ON "notes" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "profiles_update_own" ON "profiles" AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));--> statement-breakpoint
CREATE POLICY "profiles_select_own" ON "profiles" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "review_logs_own_all" ON "review_logs" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "sessions_own_all" ON "sessions" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "tags_public_read" ON "tags" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "progress_own_all" ON "user_word_progress" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "word_filter_facets_public_read" ON "word_filter_facets" AS PERMISSIVE FOR SELECT TO public USING ((count > 0));--> statement-breakpoint
CREATE POLICY "word_tags_public_read" ON "word_tags" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "wordbook_items_via_wordbook" ON "wordbook_items" AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM wordbooks w
  WHERE ((w.id = wordbook_items.wordbook_id) AND (w.user_id = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM wordbooks w
  WHERE ((w.id = wordbook_items.wordbook_id) AND (w.user_id = auth.uid())))));--> statement-breakpoint
CREATE POLICY "wordbooks_own_all" ON "wordbooks" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "words_public_read" ON "words" AS PERMISSIVE FOR SELECT TO public USING (((is_published = true) AND (is_deleted = false)));