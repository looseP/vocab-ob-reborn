/**
 * NoteRepository — extracted from v1's app/api/notes/[wordId]/route.ts.
 *
 * Parameter order convention: (userId, wordbookId, wordId, ...) — consistent
 * with annotation.repository.ts and interfaces.ts.
 *
 * Version increment: uses DB-side atomic increment to prevent race condition.
 */

import type { NoteRow, NoteRevisionRow } from "../domain";
import type { INoteRepository } from "./interfaces";
import { BaseRepository } from "./base";

export class NoteRepository extends BaseRepository implements INoteRepository {
  async findByWord(
    userId: string,
    wordbookId: string,
    wordId: string,
  ): Promise<NoteRow | null> {
    return this.queryOne<NoteRow>(
      `SELECT id, user_id, word_id, wordbook_id, content_md, version, created_at, updated_at
       FROM notes
       WHERE user_id = $1 AND wordbook_id = $2 AND word_id = $3::uuid
       LIMIT 1`,
      [userId, wordbookId, wordId],
    );
  }

  async upsert(
    userId: string,
    wordbookId: string,
    wordId: string,
    contentMd: string,
  ): Promise<{ note: NoteRow; created: boolean }> {
    const row = await this.queryOne<NoteRow & { created: boolean }>(
      `WITH upserted_note AS (
         INSERT INTO notes (user_id, word_id, wordbook_id, content_md, version)
         VALUES ($1, $2::uuid, $3::uuid, $4, 1)
         ON CONFLICT (user_id, wordbook_id, word_id)
         DO UPDATE SET
           content_md = EXCLUDED.content_md,
           version = CASE
             WHEN notes.content_md IS DISTINCT FROM EXCLUDED.content_md
             THEN notes.version + 1
             ELSE notes.version
           END,
           updated_at = CASE
             WHEN notes.content_md IS DISTINCT FROM EXCLUDED.content_md
             THEN now()
             ELSE notes.updated_at
           END
         RETURNING notes.*, (xmax = 0) AS created
       ), inserted_revision AS (
         INSERT INTO note_revisions
           (note_id, user_id, word_id, wordbook_id, content_md, version)
         SELECT id, user_id, word_id, wordbook_id, content_md, version
         FROM upserted_note
         ON CONFLICT (note_id, version) DO NOTHING
       )
       SELECT id, user_id, word_id, wordbook_id, content_md, version,
              created_at, updated_at, created
       FROM upserted_note`,
      [userId, wordId, wordbookId, contentMd],
    );
    if (!row) throw new Error("note upsert returned no row");

    return { note: row, created: row.created };
  }

  async findRevisions(
    userId: string,
    wordbookId: string,
    wordId: string,
  ): Promise<NoteRevisionRow[]> {
    return this.query<NoteRevisionRow>(
      `SELECT nr.id, nr.note_id, nr.user_id, nr.word_id, nr.wordbook_id, nr.content_md, nr.version, nr.created_at
       FROM note_revisions nr
       WHERE nr.user_id = $1 AND nr.word_id = $2::uuid AND nr.wordbook_id = $3
       ORDER BY nr.version DESC`,
      [userId, wordId, wordbookId],
    );
  }
}
