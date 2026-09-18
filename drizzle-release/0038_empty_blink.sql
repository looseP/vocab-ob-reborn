CREATE TABLE "l3_writing_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"sheet_id" uuid NOT NULL,
	"text_sha256" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"feedback" jsonb NOT NULL,
	"version" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"last_editor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_writing_feedback_user_sheet_unique" UNIQUE("user_id","sheet_id"),
	CONSTRAINT "l3_writing_feedback_schema_version_check" CHECK (schema_version = 1),
	CONSTRAINT "l3_writing_feedback_version_check" CHECK (version > 0),
	CONSTRAINT "l3_writing_feedback_text_sha256_check" CHECK (char_length(text_sha256) = 64),
	CONSTRAINT "l3_writing_feedback_last_editor_check" CHECK (char_length(last_editor) BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "l3_writing_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_writing_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"create_request_id" uuid NOT NULL,
	"create_input_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_writing_tasks_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "l3_writing_tasks_user_request_unique" UNIQUE("user_id","create_request_id"),
	CONSTRAINT "l3_writing_tasks_kind_check" CHECK (kind = ANY (ARRAY['whole'::text, 'paragraph'::text, 'free'::text])),
	CONSTRAINT "l3_writing_tasks_direction_check" CHECK (direction = ANY (ARRAY['通用'::text, '考研'::text, '雅思'::text])),
	CONSTRAINT "l3_writing_tasks_status_check" CHECK (status = ANY (ARRAY['active'::text, 'archived'::text])),
	CONSTRAINT "l3_writing_tasks_title_check" CHECK (char_length(title) BETWEEN 1 AND 120)
);
--> statement-breakpoint
ALTER TABLE "l3_writing_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "l3_question_attempts" DROP CONSTRAINT "l3_question_attempts_venue_check";--> statement-breakpoint
ALTER TABLE "l3_submissions" DROP CONSTRAINT "l3_submissions_scope_check";--> statement-breakpoint
ALTER TABLE "l3_submissions" DROP CONSTRAINT "l3_submissions_scope_shape_check";--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD COLUMN "writing_task_id" uuid;--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD COLUMN "parent_sheet_id" uuid;--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD COLUMN "revision_no" integer;--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD COLUMN "draft_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "l3_writing_feedback" ADD CONSTRAINT "l3_writing_feedback_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_writing_feedback" ADD CONSTRAINT "l3_writing_feedback_sheet_owner_fk" FOREIGN KEY ("sheet_id","user_id") REFERENCES "public"."l3_submissions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_writing_tasks" ADD CONSTRAINT "l3_writing_tasks_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_writing_tasks" ADD CONSTRAINT "l3_writing_tasks_question_owner_fk" FOREIGN KEY ("question_id","user_id") REFERENCES "public"."l3_questions"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_l3_writing_tasks_user_updated" ON "l3_writing_tasks" USING btree ("user_id","updated_at");--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD CONSTRAINT "l3_submissions_writing_task_owner_fk" FOREIGN KEY ("writing_task_id","user_id") REFERENCES "public"."l3_writing_tasks"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD CONSTRAINT "l3_submissions_parent_sheet_owner_fk" FOREIGN KEY ("parent_sheet_id","user_id") REFERENCES "public"."l3_submissions"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "l3_question_attempts_writing_sheet_unique" ON "l3_question_attempts" USING btree ("sheet_id") WHERE venue = 'writing';--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD CONSTRAINT "l3_submissions_writing_revision_unique" UNIQUE("user_id","writing_task_id","revision_no");--> statement-breakpoint
ALTER TABLE "l3_question_attempts" ADD CONSTRAINT "l3_question_attempts_venue_check" CHECK (venue = ANY (ARRAY['file'::text, 'paper'::text, 'writing'::text]));--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD CONSTRAINT "l3_submissions_writing_meta_check" CHECK ((scope = 'writing' AND writing_task_id IS NOT NULL) OR (scope <> 'writing' AND writing_task_id IS NULL AND parent_sheet_id IS NULL AND revision_no IS NULL));--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD CONSTRAINT "l3_submissions_writing_revision_check" CHECK (scope <> 'writing' OR (status = 'sealed' AND revision_no IS NOT NULL AND revision_no > 0) OR (status <> 'sealed' AND revision_no IS NULL));--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD CONSTRAINT "l3_submissions_scope_check" CHECK (scope = ANY (ARRAY['file'::text, 'paper'::text, 'writing'::text]));--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD CONSTRAINT "l3_submissions_scope_shape_check" CHECK ((scope = 'file' AND source_id IS NOT NULL AND question_type IS NOT NULL AND paper_id IS NULL) OR (scope = 'paper' AND paper_id IS NOT NULL AND source_id IS NULL AND question_type IS NULL) OR (scope = 'writing' AND source_id IS NULL AND question_type IS NULL AND paper_id IS NULL));--> statement-breakpoint
CREATE POLICY "l3_writing_feedback_own_all" ON "l3_writing_feedback" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_writing_tasks_own_all" ON "l3_writing_tasks" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));