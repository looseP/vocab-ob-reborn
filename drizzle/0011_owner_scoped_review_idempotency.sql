DROP INDEX IF EXISTS "idx_review_logs_idempotency";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_review_logs_idempotency" ON "review_logs" USING btree ("user_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
