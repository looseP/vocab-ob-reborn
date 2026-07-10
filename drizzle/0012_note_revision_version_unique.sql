WITH ranked_revisions AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY note_id, version
           ORDER BY created_at ASC, id ASC
         ) AS duplicate_rank
  FROM note_revisions
)
DELETE FROM note_revisions
WHERE id IN (
  SELECT id FROM ranked_revisions WHERE duplicate_rank > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_note_revisions_note_version"
  ON "note_revisions" USING btree ("note_id", "version");
