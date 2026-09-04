CREATE INDEX "idx_auth_sessions_expiry_cleanup" ON "auth_sessions" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "idx_auth_sessions_revoked_cleanup" ON "auth_sessions" USING btree ("revoked_at","id") WHERE revoked_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_terminal_finalized_cleanup" ON "llm_usage" USING btree ("finalized_at","id") WHERE status IN ('released', 'expired') AND finalized_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_settled_created_cleanup" ON "llm_usage" USING btree ("created_at","id") WHERE status = 'settled';--> statement-breakpoint
CREATE INDEX "idx_outbox_events_processed_cleanup" ON "outbox_events" USING btree ("processed_at","id") WHERE status = 'processed' AND processed_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_review_logs_cleanup" ON "review_logs" USING btree ("reviewed_at","id");--> statement-breakpoint
CREATE INDEX "idx_review_logs_archive_cleanup" ON "review_logs_archive" USING btree ("reviewed_at","id");