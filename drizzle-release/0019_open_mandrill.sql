CREATE TABLE "note_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"wordbook_id" uuid NOT NULL,
	"content_md" text NOT NULL,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note_entries" ADD CONSTRAINT "note_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_entries" ADD CONSTRAINT "note_entries_word_id_fkey" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_entries" ADD CONSTRAINT "fk_note_entries_wordbook" FOREIGN KEY ("wordbook_id") REFERENCES "public"."wordbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_note_entries_wordbook" ON "note_entries" USING btree ("wordbook_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_note_entries_user_word" ON "note_entries" USING btree ("user_id","word_id","hidden_at" NULLS FIRST);--> statement-breakpoint
CREATE POLICY "note_entries_own_all" ON "note_entries" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
-- 数据迁移(条目制 2026-09-06):文档笔记每篇转为 1 条条目(不按内容拆分猜测);
-- 空文档(content_md = '')跳过;notes/note_revisions 只读保留,待 P4 清理。
INSERT INTO "note_entries" ("user_id", "word_id", "wordbook_id", "content_md", "created_at", "updated_at")
SELECT "user_id", "word_id", "wordbook_id", "content_md", "created_at", "updated_at"
FROM "notes"
WHERE "content_md" <> '';