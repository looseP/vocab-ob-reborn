CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "word_l2_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"word_id" uuid NOT NULL,
	"field" text NOT NULL,
	"content" jsonb NOT NULL,
	"source" text NOT NULL,
	"source_ref" uuid,
	"approved_by" text DEFAULT 'user',
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "word_l2_content" ADD CONSTRAINT "word_l2_content_word_id_words_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_created" ON "llm_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_l2_content_word_field" ON "word_l2_content" USING btree ("word_id","field");--> statement-breakpoint
CREATE INDEX "idx_l2_content_source" ON "word_l2_content" USING btree ("source");