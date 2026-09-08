-- 0021: grant UPDATE on l3_sources / l3_contexts to vocab_app.
--
-- The capture flow (POST /api/l3/sources/:id/captures) takes a row lock with
-- SELECT ... FOR UPDATE (lockSourceByIdForUser in l3-context.service.ts)
-- before appending content_text / occurrences; the context flow does the same
-- via lockContextByIdForUser. PostgreSQL requires the table-level UPDATE
-- privilege for FOR UPDATE row locks, so without this grant both endpoints
-- fail with "permission denied for table l3_sources" (HTTP 500).

GRANT UPDATE ON TABLE "l3_sources" TO "vocab_app";--> statement-breakpoint
GRANT UPDATE ON TABLE "l3_contexts" TO "vocab_app";
