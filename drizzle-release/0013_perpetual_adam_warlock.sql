CREATE TABLE "l2_drill_session_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"wordbook_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"progress_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"step_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"task_id" text,
	"task_type" text,
	"task_payload" jsonb,
	"outcome" text,
	"mapped_rating" "review_rating",
	"review_log_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "l2_drill_steps_id_user_wordbook_unique" UNIQUE("id","user_id","wordbook_id"),
	CONSTRAINT "l2_drill_steps_step_type_check" CHECK (step_type = ANY (ARRAY['l2_discrimination'::text, 'l2_production'::text])),
	CONSTRAINT "l2_drill_steps_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'completed'::text, 'skipped'::text])),
	CONSTRAINT "l2_drill_steps_task_type_check" CHECK (task_type IS NULL OR task_type = ANY (ARRAY['cloze_mcq'::text, 'synonym_discrimination'::text, 'production'::text])),
	CONSTRAINT "l2_drill_steps_outcome_check" CHECK (outcome IS NULL OR outcome = ANY (ARRAY['correct'::text, 'incorrect'::text, 'self_passed'::text, 'self_weak'::text]))
);
--> statement-breakpoint
ALTER TABLE "l2_drill_session_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_mode_check";--> statement-breakpoint
ALTER TABLE "review_logs" DROP CONSTRAINT "review_logs_progress_id_fkey";
--> statement-breakpoint
ALTER TABLE "review_logs" DROP CONSTRAINT "review_logs_progress_scope_fkey";
--> statement-breakpoint
ALTER TABLE "user_word_l2_progress" ADD COLUMN "l2_production_status" text;--> statement-breakpoint
ALTER TABLE "l2_drill_session_steps" ADD CONSTRAINT "l2_drill_steps_session_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l2_drill_session_steps" ADD CONSTRAINT "l2_drill_steps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l2_drill_session_steps" ADD CONSTRAINT "l2_drill_steps_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l2_drill_session_steps" ADD CONSTRAINT "fk_l2_drill_steps_wordbook" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l2_drill_session_steps" ADD CONSTRAINT "l2_drill_steps_session_scope_fkey" FOREIGN KEY ("session_id","user_id","wordbook_id") REFERENCES "public"."sessions"("id","user_id","wordbook_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l2_drill_session_steps" ADD CONSTRAINT "l2_drill_steps_wordbook_owner_fkey" FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_l2_drill_steps_session_word_step" ON "l2_drill_session_steps" USING btree ("session_id","word_id","step_index");--> statement-breakpoint
CREATE INDEX "idx_l2_drill_steps_session" ON "l2_drill_session_steps" USING btree ("session_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_l2_drill_steps_user_word" ON "l2_drill_session_steps" USING btree ("user_id","word_id");--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_track_check" CHECK (track = ANY (ARRAY['l1'::text, 'l2'::text]));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_mode_check" CHECK (mode = ANY (ARRAY['review'::text, 'cram'::text, 'preview'::text, 'l2_drill'::text]));--> statement-breakpoint
ALTER TABLE "user_word_l2_progress" ADD CONSTRAINT "l2_production_status_check" CHECK (l2_production_status IS NULL OR l2_production_status = ANY (ARRAY['passed'::text, 'weak'::text]));--> statement-breakpoint
CREATE POLICY "l2_drill_steps_own_all" ON "l2_drill_session_steps" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint

-- ── payload 断路修复·存量化（2026-08-24 l2-drill spec §四）──────────────────
-- 继承行出生时从未写过 l2_scheduler_payload（落库为 {}），toCard({}) 因 Invalid Date
-- 返回 createEmptyCard()，首次作答会把继承卡当 New 卡按分钟级 learning 步调度。
-- 从行上权威标量列重建初始调度身份（state=2 即 ts-fsrs State.Review）。
UPDATE "user_word_l2_progress" AS p
SET "l2_scheduler_payload" = jsonb_build_object(
  'difficulty', p.l2_difficulty,
  'due', to_char(p.l2_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'elapsed_days', 0,
  'scheduled_days', 0,
  'reps', 0,
  'lapses', 0,
  'learning_steps', 0,
  'last_review', NULL,
  'stability', p.l2_stability,
  'state', 2
)
WHERE COALESCE(p."l2_scheduler_payload", '{}'::jsonb) = '{}'::jsonb
  AND p.l2_due_at IS NOT NULL;