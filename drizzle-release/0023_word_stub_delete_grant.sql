-- 0023: vocab_app hard-deletes stub words (definition_md = '') from the word
-- detail page (详情页删除生词条目, 2026-09-08 stub 生命周期评估).
--
-- words is GLOBAL (no user_id column): the only safe guard is the stub
-- convention definition_md = '' (NOT NULL, stub rows write '').
--
-- DB-level guard = RLS DELETE policy below: words has RLS ENABLED with only
-- words_public_read (SELECT, 0000:727) — a bare GRANT DELETE would silently
-- delete 0 rows without an explicit FOR DELETE policy for vocab_app (承重
-- 陷阱). The policy restricts deletion to stub rows for the ONLY runtime role
-- holding DELETE (vocab_app), and db:schema:drift verifies the policy against
-- the authoritative contract on every run (policy drift is gated).
--
-- Deliberately NO extra trigger: integration fixtures legitimately seed and
-- delete content-bearing words via their test connection (review-service /
-- data-lifecycle / l2-drill cleanups), so an absolute stub-only trigger would
-- break verify:db. The service layer guards the API surface (stub pre-check +
-- FOR UPDATE lock with stub predicate + guarded DELETE + 409 blockers for
-- bound L3 occurrences / note entries / inbound word-links); review progress
-- and wordbook membership cascade by FK (they ARE the pollution being
-- cleaned).

GRANT DELETE ON TABLE "words" TO "vocab_app";--> statement-breakpoint

CREATE POLICY "words_stub_delete_app" ON "words"
AS PERMISSIVE FOR DELETE TO "vocab_app"
USING (definition_md = '' AND is_published = true AND is_deleted = false);
