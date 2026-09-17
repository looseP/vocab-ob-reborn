CREATE TABLE "l3_grading_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"sheet_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"analysis_md" text,
	"graded_by" text NOT NULL,
	"graded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_grading_results_sheet_question_unique" UNIQUE("sheet_id","question_id"),
	CONSTRAINT "l3_grading_results_verdict_check" CHECK (verdict = ANY (ARRAY['correct'::text, 'partial'::text, 'wrong'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_grading_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "l3_grading_results" ADD CONSTRAINT "l3_grading_results_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_grading_results" ADD CONSTRAINT "l3_grading_results_sheet_id_l3_submissions_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."l3_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_grading_results" ADD CONSTRAINT "l3_grading_results_question_id_l3_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."l3_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "l3_grading_results_own_all" ON "l3_grading_results" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));