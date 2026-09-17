CREATE TABLE "l3_annotation_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_annotation_tags_kind_check" CHECK (kind = ANY (ARRAY['entry'::text, 'option'::text])),
	CONSTRAINT "l3_annotation_tags_status_check" CHECK (status = ANY (ARRAY['active'::text, 'deleted'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_annotation_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_question_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"anchor_start" integer,
	"anchor_end" integer,
	"excerpt" text,
	"note" text DEFAULT '' NOT NULL,
	"entry_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"option_tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_question_annotations_anchor_pair_check" CHECK ((anchor_start IS NULL) = (anchor_end IS NULL)),
	CONSTRAINT "l3_question_annotations_anchor_order_check" CHECK (anchor_start IS NULL OR anchor_end > anchor_start),
	CONSTRAINT "l3_question_annotations_excerpt_check" CHECK ((anchor_start IS NULL) = (excerpt IS NULL)),
	CONSTRAINT "l3_question_annotations_status_check" CHECK (status = ANY (ARRAY['active'::text, 'deleted'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_question_annotations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "l3_annotation_tags" ADD CONSTRAINT "l3_annotation_tags_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_question_annotations" ADD CONSTRAINT "l3_question_annotations_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_question_annotations" ADD CONSTRAINT "l3_question_annotations_question_id_l3_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."l3_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_l3_annotation_tags_user_kind_ordinal" ON "l3_annotation_tags" USING btree ("user_id","kind","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "l3_annotation_tags_user_kind_label_unique" ON "l3_annotation_tags" USING btree ("user_id","kind","label") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_l3_question_annotations_user_question" ON "l3_question_annotations" USING btree ("user_id","question_id") WHERE status = 'active';--> statement-breakpoint
CREATE POLICY "l3_annotation_tags_own_all" ON "l3_annotation_tags" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_question_annotations_own_all" ON "l3_question_annotations" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));