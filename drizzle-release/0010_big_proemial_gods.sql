ALTER TABLE "review_logs_archive" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "review_logs_archive" ADD COLUMN "previous_progress_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "review_logs_archive" ADD COLUMN "undone" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "review_logs_archive" ADD COLUMN "undone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_logs_archive" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "review_logs_archive" ADD COLUMN "track" text DEFAULT 'l1' NOT NULL;