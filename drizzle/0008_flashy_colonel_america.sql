CREATE TABLE "l3_proposal_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"ordinal" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"validation_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_entity_type" text,
	"active_entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_proposal_items_proposal_ordinal_unique" UNIQUE("proposal_id","ordinal"),
	CONSTRAINT "l3_proposal_items_item_type_check" CHECK (item_type = ANY (ARRAY['source'::text, 'context'::text, 'occurrence'::text, 'context_link'::text])),
	CONSTRAINT "l3_proposal_items_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'rejected'::text])),
	CONSTRAINT "l3_proposal_items_active_entity_type_check" CHECK (active_entity_type IS NULL OR active_entity_type = ANY (ARRAY['source'::text, 'context'::text, 'occurrence'::text, 'context_link'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_proposal_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "l3_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wordbook_id" uuid,
	"source_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text,
	"summary" text,
	"input_hash" text,
	"proposed_by" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"review_note" text,
	"confirmed_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_proposals_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "l3_proposals_source_type_check" CHECK (source_type = ANY (ARRAY['agent'::text, 'import'::text, 'external_tool'::text, 'manual_draft'::text, 'mcp_future'::text, 'other'::text])),
	CONSTRAINT "l3_proposals_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'rejected'::text, 'canceled'::text]))
);
--> statement-breakpoint
ALTER TABLE "l3_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "l3_proposal_items" ADD CONSTRAINT "l3_proposal_items_proposal_id_l3_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."l3_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_proposal_items" ADD CONSTRAINT "l3_proposal_items_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_proposal_items" ADD CONSTRAINT "l3_proposal_items_proposal_owner_fk" FOREIGN KEY ("proposal_id","user_id") REFERENCES "public"."l3_proposals"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_proposals" ADD CONSTRAINT "l3_proposals_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_proposals" ADD CONSTRAINT "l3_proposals_wordbook_owner_fk" FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_l3_proposal_items_proposal_ordinal" ON "l3_proposal_items" USING btree ("proposal_id","ordinal");--> statement-breakpoint
CREATE INDEX "idx_l3_proposal_items_user_status" ON "l3_proposal_items" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_l3_proposals_user_status_created" ON "l3_proposals" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE POLICY "l3_proposal_items_own_all" ON "l3_proposal_items" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "l3_proposals_own_all" ON "l3_proposals" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));