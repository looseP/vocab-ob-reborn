/**
 * AnnotationRepository — migrated from v1's lib/annotations/repository.ts.
 *
 * Parameter order convention: (userId, wordbookId, wordId, ...) — consistent
 * with note.repository.ts and interfaces.ts.
 */

import type { AnnotationRow } from "../domain";
import type { IAnnotationRepository } from "./interfaces";
import { BaseRepository } from "./base";

export class AnnotationRepository extends BaseRepository implements IAnnotationRepository {
  async findByWord(
    userId: string,
    wordbookId: string,
    wordId: string,
  ): Promise<AnnotationRow | null> {
    return this.queryOne<AnnotationRow>(
      `SELECT id, user_id, word_id, wordbook_id, content, updated_at
       FROM word_annotations
       WHERE user_id = $1 AND wordbook_id = $2 AND word_id = $3::uuid
       LIMIT 1`,
      [userId, wordbookId, wordId],
    );
  }

  async upsert(
    userId: string,
    wordbookId: string,
    wordId: string,
    content: string,
  ): Promise<AnnotationRow> {
    const row = await this.queryOne<AnnotationRow>(
      `INSERT INTO word_annotations (user_id, word_id, wordbook_id, content)
       VALUES ($1, $2::uuid, $3, $4)
       ON CONFLICT (user_id, wordbook_id, word_id)
       DO UPDATE SET content = EXCLUDED.content, updated_at = now()
       RETURNING id, user_id, word_id, wordbook_id, content, updated_at`,
      [userId, wordId, wordbookId, content],
    );
    if (!row) throw new Error("upsert annotation returned no row");
    return row;
  }

  async delete(
    userId: string,
    wordbookId: string,
    annotationId: string,
  ): Promise<void> {
    await this.query(
      `DELETE FROM word_annotations
       WHERE id = $1 AND user_id = $2 AND wordbook_id = $3`,
      [annotationId, userId, wordbookId],
    );
  }
}
