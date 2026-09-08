-- 0024: grant UPDATE on words to vocab_app for FOR UPDATE row locks.
--
-- The stub-delete flow (DELETE /api/words/:slug, 0023) locks the stub row
-- with SELECT ... FOR UPDATE (lockStubWordById in word.repository.ts) before
-- the guarded delete. PostgreSQL requires the table-level UPDATE privilege
-- for FOR UPDATE row locks, so without this grant the endpoint fails with
-- "permission denied for table words" (HTTP 500) — same trap as 0021 on
-- l3_sources / l3_contexts.
--
-- Privilege without policy: words has RLS ENABLED and there is deliberately
-- NO UPDATE policy for vocab_app, so actual UPDATE statements by the runtime
-- role still silently affect 0 rows. The privilege only enables row locking.

GRANT UPDATE ON TABLE "words" TO "vocab_app";
