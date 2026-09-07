ALTER TABLE "l3_sources" ADD COLUMN "content_text" text;--> statement-breakpoint
ALTER TABLE "l3_sources" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "l3_sources_user_content_hash_unique" ON "l3_sources" USING btree ("user_id","content_hash") WHERE content_hash IS NOT NULL;