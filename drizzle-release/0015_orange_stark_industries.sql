ALTER TABLE "words" ADD COLUMN "pinyin" text;--> statement-breakpoint
ALTER TABLE "words" ADD COLUMN "pinyin_initial" text;--> statement-breakpoint
CREATE INDEX "idx_words_pinyin_trgm" ON "words" USING gin ("pinyin" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_words_pinyin_initial_trgm" ON "words" USING gin ("pinyin_initial" gin_trgm_ops);