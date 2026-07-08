CREATE TABLE "l3_recommendation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"wordbook_id" uuid,
	"recommendation_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"priority_score" numeric(8, 4) NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accepted_proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "l3_recommendation_items_type_check" CHECK (recommendation_type = ANY (ARRAY['review_pack'::text, 'learn_next'::text, 'link_gap'::text, 'context_gap'::text, 'l2_gap'::text, 'weak_word'::text, 'related_word'::text])),
	CONSTRAINT "l3_recommendation_items_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'dismissed'::text, 'expired'::text])),
	CONSTRAINT "l3_recommendation_items_priority_check" CHECK (priority_score >= 0),
	CONSTRAINT "l3_recommendation_items_confidence_check" CHECK (confidence >= 0 AND confidence <= 1)
);
--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_recommendation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wordbook_id" uuid,
	"mode" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"input_hash" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "l3_recommendation_runs_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "l3_recommendation_runs_mode_check" CHECK (mode = ANY (ARRAY['review_pack'::text, 'learn_next'::text, 'gap_scan'::text, 'link_suggestions'::text])),
	CONSTRAINT "l3_recommendation_runs_status_check" CHECK (status = ANY (ARRAY['completed'::text, 'failed'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_recommendation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ADD CONSTRAINT "l3_recommendation_items_run_id_l3_recommendation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."l3_recommendation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ADD CONSTRAINT "l3_recommendation_items_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ADD CONSTRAINT "l3_recommendation_items_run_owner_fk" FOREIGN KEY ("run_id","user_id") REFERENCES "public"."l3_recommendation_runs"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ADD CONSTRAINT "l3_recommendation_items_wordbook_owner_fk" FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_items" ADD CONSTRAINT "l3_recommendation_items_proposal_owner_fk" FOREIGN KEY ("accepted_proposal_id","user_id") REFERENCES "public"."l3_proposals"("id","user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_runs" ADD CONSTRAINT "l3_recommendation_runs_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_recommendation_runs" ADD CONSTRAINT "l3_recommendation_runs_wordbook_owner_fk" FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_l3_recommendation_items_user_status_created" ON "l3_recommendation_items" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_l3_recommendation_items_run" ON "l3_recommendation_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_l3_recommendation_runs_user_created" ON "l3_recommendation_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE POLICY "l3_recommendation_items_own_all" ON "l3_recommendation_items" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_recommendation_runs_own_all" ON "l3_recommendation_runs" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));