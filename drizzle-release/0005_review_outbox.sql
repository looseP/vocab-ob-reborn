CREATE TABLE "outbox_effect_receipts" (
	"event_id" uuid NOT NULL,
	"effect_name" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_effect_receipts_pkey" PRIMARY KEY("event_id","effect_name")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_dedupe_key_key" UNIQUE("dedupe_key"),
	CONSTRAINT "outbox_events_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'retry'::text, 'processing'::text, 'processed'::text, 'dead_letter'::text])),
	CONSTRAINT "outbox_events_attempts_check" CHECK (attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts)
);
--> statement-breakpoint
ALTER TABLE "outbox_effect_receipts" ADD CONSTRAINT "outbox_effect_receipts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."outbox_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_outbox_events_claim" ON "outbox_events" USING btree ("available_at","created_at") WHERE status IN ('pending', 'retry');--> statement-breakpoint
CREATE INDEX "idx_outbox_events_lease" ON "outbox_events" USING btree ("locked_until") WHERE status = 'processing';--> statement-breakpoint
CREATE INDEX "idx_outbox_events_dead_letter" ON "outbox_events" USING btree ("updated_at") WHERE status = 'dead_letter';