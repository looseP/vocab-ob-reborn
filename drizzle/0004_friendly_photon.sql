DROP INDEX "idx_l2_progress_user_word";--> statement-breakpoint
DROP INDEX "idx_l2_progress_due";--> statement-breakpoint
ALTER TABLE "user_word_l2_progress" ADD COLUMN "wordbook_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "user_word_l2_progress" ADD CONSTRAINT "user_word_l2_progress_wordbook_id_wordbooks_id_fk" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_l2_progress_user_wordbook_word" ON "user_word_l2_progress" USING btree ("user_id","wordbook_id","word_id");--> statement-breakpoint
CREATE INDEX "idx_l2_progress_wordbook_due" ON "user_word_l2_progress" USING btree ("wordbook_id","user_id","l2_due_at") WHERE (l2_paused = false);