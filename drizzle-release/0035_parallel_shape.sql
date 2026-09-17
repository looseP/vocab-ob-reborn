CREATE TABLE "l3_question_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"content_md" text NOT NULL,
	"last_editor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_question_assessments_user_question_unique" UNIQUE("user_id","question_id"),
	CONSTRAINT "l3_question_assessments_last_editor_check" CHECK (last_editor = ANY (ARRAY['owner'::text, 'agent'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_question_assessments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "l3_question_assessments" ADD CONSTRAINT "l3_question_assessments_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_question_assessments" ADD CONSTRAINT "l3_question_assessments_question_id_l3_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."l3_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "l3_question_assessments_own_all" ON "l3_question_assessments" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));