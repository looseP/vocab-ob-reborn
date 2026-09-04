ALTER TABLE "user_word_l2_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "user_word_l2_progress_own_all" ON "user_word_l2_progress";--> statement-breakpoint
CREATE POLICY "user_word_l2_progress_own_all" ON "user_word_l2_progress" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));