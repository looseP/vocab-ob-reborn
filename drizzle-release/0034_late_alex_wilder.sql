CREATE TABLE "l3_question_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"sheet_id" uuid,
	"venue" text NOT NULL,
	"answer" jsonb NOT NULL,
	"self_assessment" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_question_attempts_venue_check" CHECK (venue = ANY (ARRAY['file'::text, 'paper'::text])),
	CONSTRAINT "l3_question_attempts_status_check" CHECK (status = ANY (ARRAY['active'::text, 'deleted'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_question_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"source_id" uuid,
	"question_type" text,
	"paper_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seal_mode" text,
	"summary" text,
	"sealed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_submissions_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "l3_submissions_scope_check" CHECK (scope = ANY (ARRAY['file'::text, 'paper'::text])),
	CONSTRAINT "l3_submissions_scope_shape_check" CHECK ((scope = 'file' AND source_id IS NOT NULL AND question_type IS NOT NULL AND paper_id IS NULL) OR (scope = 'paper' AND paper_id IS NOT NULL AND source_id IS NULL AND question_type IS NULL)),
	CONSTRAINT "l3_submissions_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'sealed'::text, 'discarded'::text])),
	CONSTRAINT "l3_submissions_seal_mode_check" CHECK (seal_mode IS NULL OR seal_mode = ANY (ARRAY['full'::text, 'incremental'::text, 'summary'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "l3_question_annotations" ADD COLUMN "stage" text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "l3_question_annotations" ADD COLUMN "sheet_id" uuid;--> statement-breakpoint
ALTER TABLE "l3_question_annotations" ADD COLUMN "review" jsonb;--> statement-breakpoint
ALTER TABLE "l3_question_attempts" ADD CONSTRAINT "l3_question_attempts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_question_attempts" ADD CONSTRAINT "l3_question_attempts_question_id_l3_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."l3_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_question_attempts" ADD CONSTRAINT "l3_question_attempts_sheet_id_l3_submissions_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."l3_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD CONSTRAINT "l3_submissions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD CONSTRAINT "l3_submissions_source_owner_fk" FOREIGN KEY ("source_id","user_id") REFERENCES "public"."l3_sources"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD CONSTRAINT "l3_submissions_paper_owner_fk" FOREIGN KEY ("paper_id","user_id") REFERENCES "public"."l3_papers"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_l3_question_attempts_user_question_created" ON "l3_question_attempts" USING btree ("user_id","question_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_l3_question_attempts_sheet" ON "l3_question_attempts" USING btree ("sheet_id");--> statement-breakpoint
CREATE INDEX "idx_l3_submissions_user_created" ON "l3_submissions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_l3_submissions_user_status" ON "l3_submissions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "l3_submissions_user_scope_key_draft_unique" ON "l3_submissions" USING btree ("user_id","scope_key") WHERE status = 'draft';--> statement-breakpoint
ALTER TABLE "l3_question_annotations" ADD CONSTRAINT "l3_question_annotations_sheet_id_l3_submissions_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."l3_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "l3_question_attempts_own_all" ON "l3_question_attempts" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_submissions_own_all" ON "l3_submissions" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));