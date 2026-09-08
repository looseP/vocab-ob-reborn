-- 0025: stub-only UPDATE policy for vocab_app on words (row-lock visibility).
--
-- Empirical finding from the UI smoke test: under RLS, SELECT ... FOR UPDATE
-- requires the row to pass BOTH the SELECT policy and an UPDATE policy —
-- words had only words_public_read (SELECT), so lockStubWordById silently
-- matched 0 rows as vocab_app (the API surfaced 404, not an error; the
-- missing UPDATE *privilege* would have been a 500 "permission denied",
-- already fixed by 0024). Both are required for FOR UPDATE row locks.
--
-- Mirrors words_stub_delete_app (0023): stub rows only. Actual UPDATE
-- statements by the runtime role stay scoped to stub rows by the same
-- USING clause; there is no app-code path that UPDATEs words (writes go
-- through the dedicated batch-import role). DROP IF EXISTS + CREATE is the
-- portable idempotent form (Postgres 17 has no CREATE POLICY IF NOT EXISTS).

DROP POLICY IF EXISTS words_stub_update_app ON "words";--> statement-breakpoint

CREATE POLICY "words_stub_update_app" ON "words"
AS PERMISSIVE FOR UPDATE TO "vocab_app"
USING (definition_md = '' AND is_published = true AND is_deleted = false);
