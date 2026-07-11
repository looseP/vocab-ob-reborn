CREATE TABLE "login_rate_limits" (
  "key_hash" text PRIMARY KEY NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "window_expires_at" timestamp with time zone NOT NULL,
  "attempts" integer NOT NULL,
  CONSTRAINT "login_rate_limits_key_hash_check" CHECK ("key_hash" ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT "login_rate_limits_attempts_check" CHECK ("attempts" > 0),
  CONSTRAINT "login_rate_limits_window_check" CHECK ("window_expires_at" > "window_started_at")
);--> statement-breakpoint
CREATE INDEX "idx_login_rate_limits_expiry" ON "login_rate_limits" USING btree ("window_expires_at");
