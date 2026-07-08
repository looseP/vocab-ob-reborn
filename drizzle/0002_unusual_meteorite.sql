CREATE TABLE "user_word_l2_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
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
ALTER TABLE "review_logs" ADD COLUMN "track" text DEFAULT 'l1' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_word_progress" ADD COLUMN "l1_content_hash_snapshot" text;--> statement-breakpoint
ALTER TABLE "user_word_progress" ADD COLUMN "recent_ratings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_word_progress" ADD COLUMN "l1_weak_signal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "words" ADD COLUMN "l1_content_hash" text;--> statement-breakpoint
ALTER TABLE "words" ADD COLUMN "l2_content_hash" text;--> statement-breakpoint
ALTER TABLE "user_word_l2_progress" ADD CONSTRAINT "user_word_l2_progress_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_word_l2_progress" ADD CONSTRAINT "user_word_l2_progress_word_id_words_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_l2_progress_user_word" ON "user_word_l2_progress" USING btree ("user_id","word_id");--> statement-breakpoint
CREATE INDEX "idx_l2_progress_due" ON "user_word_l2_progress" USING btree ("user_id","l2_due_at") WHERE (l2_paused = false);--> statement-breakpoint
CREATE INDEX "idx_l2_progress_word" ON "user_word_l2_progress" USING btree ("word_id");--> statement-breakpoint
CREATE INDEX "idx_review_logs_user_track_reviewed" ON "review_logs" USING btree ("user_id" uuid_ops,"track" text_ops,"reviewed_at" timestamptz_ops);